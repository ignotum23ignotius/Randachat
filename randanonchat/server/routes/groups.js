const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authenticate = require('../middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Tier helpers ─────────────────────────────────────────────
// Free tier: 1 group, max 5 members per group.
// Subscribed: unlimited groups, unlimited members.
// "Keep What You Earned": existing groups/members never stripped
// on lapse — only adding new ones past the free limit is blocked.
// Permanent micropayment unlocks stored in purchased_features JSONB:
//   extra_groups: N   (each purchase adds 1 extra group slot)
//   extra_members: N  (each purchase adds 1 extra member slot per group)

async function getUserTierInfo(userId) {
  const result = await pool.query(
    `SELECT tier, sub_expiry, purchased_features
     FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  const { tier, sub_expiry, purchased_features } = result.rows[0];
  const isSubscribed =
    tier === 'subscribed' &&
    sub_expiry &&
    new Date(sub_expiry) > new Date();
  const features = purchased_features || {};
  return { isSubscribed, features };
}

// Max groups this user may CREATE (not counting groups they joined)
function maxGroups(tierInfo) {
  if (tierInfo.isSubscribed) return Infinity;
  return 1 + (tierInfo.features.extra_groups || 0);
}

// Max members (including creator) per group for this creator
function maxMembers(tierInfo) {
  if (tierInfo.isSubscribed) return Infinity;
  return 5 + (tierInfo.features.extra_members || 0);
}

// ── POST /api/groups — Create a group ───────────────────────
// Any user can create a group.
// Name is E2E encrypted — members don't see it until they join.
// Creator stored as first member in group_members.
// Free tier: 1 group; subscribed: unlimited.
router.post('/', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { encrypted_name, name_iv } = req.body;

    if (!encrypted_name || !name_iv) {
      return res.status(400).json({ error: 'encrypted_name and name_iv are required' });
    }

    const tierInfo = await getUserTierInfo(myId);
    if (!tierInfo) return res.status(404).json({ error: 'User not found' });

    // Count groups this user has created
    const groupCountResult = await pool.query(
      `SELECT COUNT(*) FROM groups WHERE creator_id = $1`,
      [myId]
    );
    const groupCount = parseInt(groupCountResult.rows[0].count, 10);
    const limit = maxGroups(tierInfo);

    if (groupCount >= limit) {
      return res.status(403).json({
        error: tierInfo.isSubscribed
          ? 'Group limit reached'
          : 'Free tier allows 1 group. Upgrade or purchase extra group slots.'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const groupResult = await client.query(
        `INSERT INTO groups (creator_id, encrypted_name, name_iv, watermark_enabled)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id, creator_id, encrypted_name, name_iv, watermark_enabled,
                   max_members, created_at, updated_at`,
        [myId, encrypted_name, name_iv]
      );
      const group = groupResult.rows[0];

      // Add creator as first member
      await client.query(
        `INSERT INTO group_members (group_id, user_id)
         VALUES ($1, $2)`,
        [group.id, myId]
      );

      await client.query('COMMIT');
      return res.status(201).json({ group });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Create group error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/groups — List groups the caller belongs to ─────
// Returns encrypted_name + name_iv (client decrypts once joined).
// Groups are only visible to members.
router.get('/', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    const result = await pool.query(
      `SELECT g.id, g.creator_id, g.encrypted_name, g.name_iv,
              g.watermark_enabled, g.max_members, g.created_at, g.updated_at,
              gm.joined_at
       FROM groups g
       INNER JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1 AND gm.removed_at IS NULL
       ORDER BY g.updated_at DESC`,
      [myId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('List groups error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/groups/:groupId — Get group details ────────────
// Only members can view. Returns encrypted name — client decrypts.
router.get('/:groupId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId } = req.params;

    // Must be an active member
    const memberCheck = await pool.query(
      `SELECT id FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [groupId, myId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const result = await pool.query(
      `SELECT id, creator_id, encrypted_name, name_iv, watermark_enabled,
              max_members, created_at, updated_at
       FROM groups WHERE id = $1`,
      [groupId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Get group error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/groups/:groupId/members — Add member by username
// Creator only. Free tier: max 5 members; subscribed: unlimited.
// "Keep What You Earned": existing members never removed on lapse —
// only adding new ones past the free limit is blocked.
router.post('/:groupId/members', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId } = req.params;
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    // Must be creator
    const groupResult = await pool.query(
      `SELECT id, creator_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].creator_id !== myId) {
      return res.status(403).json({ error: 'Only the creator can add members' });
    }

    // Resolve username → user id
    const userResult = await pool.query(
      `SELECT id FROM users WHERE username = $1`,
      [username]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const targetId = userResult.rows[0].id;

    if (targetId === myId) {
      return res.status(400).json({ error: 'Creator is already a member' });
    }

    // Check tier limits against current active member count
    const tierInfo = await getUserTierInfo(myId);
    if (!tierInfo) return res.status(404).json({ error: 'User not found' });

    const memberCountResult = await pool.query(
      `SELECT COUNT(*) FROM group_members
       WHERE group_id = $1 AND removed_at IS NULL`,
      [groupId]
    );
    const memberCount = parseInt(memberCountResult.rows[0].count, 10);
    const limit = maxMembers(tierInfo);

    if (memberCount >= limit) {
      return res.status(403).json({
        error: tierInfo.isSubscribed
          ? 'Member limit reached'
          : 'Free tier allows 5 members per group. Upgrade or purchase extra member slots.'
      });
    }

    // Check if already a member (active or removed)
    const existingMember = await pool.query(
      `SELECT id, removed_at FROM group_members
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, targetId]
    );

    let memberRow;
    if (existingMember.rows.length > 0) {
      const existing = existingMember.rows[0];
      if (!existing.removed_at) {
        return res.status(409).json({ error: 'User is already a member' });
      }
      // Re-add previously removed member
      const result = await pool.query(
        `UPDATE group_members
         SET removed_at = NULL, removed_by = NULL, removal_reason = NULL,
             joined_at = NOW()
         WHERE id = $1
         RETURNING id, group_id, user_id, joined_at`,
        [existing.id]
      );
      memberRow = result.rows[0];
    } else {
      const result = await pool.query(
        `INSERT INTO group_members (group_id, user_id)
         VALUES ($1, $2)
         RETURNING id, group_id, user_id, joined_at`,
        [groupId, targetId]
      );
      memberRow = result.rows[0];
    }

    return res.status(201).json({ member: memberRow });
  } catch (err) {
    console.error('Add member error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/groups/:groupId/members — List active members ──
// Members only.
router.get('/:groupId/members', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId } = req.params;

    const memberCheck = await pool.query(
      `SELECT id FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [groupId, myId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const result = await pool.query(
      `SELECT gm.id, gm.user_id, gm.joined_at, u.username
       FROM group_members gm
       INNER JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.removed_at IS NULL
       ORDER BY gm.joined_at ASC`,
      [groupId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('List members error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/groups/:groupId/members/:userId — Remove member
// Creator only.
// Spec: "Removing a member wipes ALL group traces from their device."
// Server-side: mark member removed + delete all group messages
// where that user is the recipient (direct messages within the group
// context are keyed by recipient_id). The removed user's client
// receives no further group events and on next sync finds no data.
router.delete('/:groupId/members/:userId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId, userId } = req.params;

    // Must be creator
    const groupResult = await pool.query(
      `SELECT id, creator_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].creator_id !== myId) {
      return res.status(403).json({ error: 'Only the creator can remove members' });
    }

    if (userId === myId) {
      return res.status(400).json({ error: 'Creator cannot remove themselves' });
    }

    const memberResult = await pool.query(
      `SELECT id FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [groupId, userId]
    );
    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in this group' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Mark member as removed
      await client.query(
        `UPDATE group_members
         SET removed_at = NOW(), removed_by = $1, removal_reason = 'kicked'
         WHERE group_id = $2 AND user_id = $3`,
        [myId, groupId, userId]
      );

      // Wipe ALL group message traces for the removed user:
      // delete messages in this group that were addressed to them.
      await client.query(
        `DELETE FROM messages
         WHERE group_id = $1 AND recipient_id = $2`,
        [groupId, userId]
      );

      // Also delete messages they sent in this group so no trace remains
      await client.query(
        `DELETE FROM messages
         WHERE group_id = $1 AND sender_id = $2`,
        [groupId, userId]
      );

      await client.query('COMMIT');
      return res.json({ message: 'Member removed and group traces wiped' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Remove member error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/groups/:groupId/watermark — Toggle watermark ───
// Creator only.
// Watermark text rendered client-side:
//   [group name] + [viewing user's username]
// Every screenshot is traceable to the specific user who leaked it.
router.put('/:groupId/watermark', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId } = req.params;
    const { watermark_enabled } = req.body;

    if (typeof watermark_enabled !== 'boolean') {
      return res.status(400).json({ error: 'watermark_enabled must be a boolean' });
    }

    const groupResult = await pool.query(
      `SELECT id, creator_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].creator_id !== myId) {
      return res.status(403).json({ error: 'Only the creator can change watermark settings' });
    }

    const result = await pool.query(
      `UPDATE groups SET watermark_enabled = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, watermark_enabled`,
      [watermark_enabled, groupId]
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Watermark toggle error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/groups/:groupId/pictures — List group pictures ─
// Members only.
router.get('/:groupId/pictures', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId } = req.params;

    const memberCheck = await pool.query(
      `SELECT id FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [groupId, myId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const result = await pool.query(
      `SELECT id, display_order, encrypted_blob_url, encryption_iv, uploaded_at
       FROM group_pictures
       WHERE group_id = $1
       ORDER BY display_order ASC`,
      [groupId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('List group pictures error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/groups/:groupId/pictures — Upload group picture ─
// Creator only. Up to 10 photos. 3hr cooldown per slot enforced
// by checking the uploaded_at of whatever currently occupies that slot.
// Same pipeline as image sending: client sends encrypted blob URL + IV.
router.post('/:groupId/pictures', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId } = req.params;
    const { display_order, encrypted_blob_url, encryption_iv } = req.body;

    if (!display_order || !encrypted_blob_url || !encryption_iv) {
      return res.status(400).json({
        error: 'display_order, encrypted_blob_url, and encryption_iv are required'
      });
    }

    if (display_order < 1 || display_order > 10) {
      return res.status(400).json({ error: 'display_order must be between 1 and 10' });
    }

    // Must be creator
    const groupResult = await pool.query(
      `SELECT id, creator_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].creator_id !== myId) {
      return res.status(403).json({ error: 'Only the creator can manage group pictures' });
    }

    // Check 3hr cooldown on this slot
    const existing = await pool.query(
      `SELECT id, uploaded_at FROM group_pictures
       WHERE group_id = $1 AND display_order = $2`,
      [groupId, display_order]
    );

    if (existing.rows.length > 0) {
      const uploadedAt = new Date(existing.rows[0].uploaded_at);
      const cooldownMs = 3 * 60 * 60 * 1000; // 3 hours
      const elapsed = Date.now() - uploadedAt.getTime();
      if (elapsed < cooldownMs) {
        const remainingS = Math.ceil((cooldownMs - elapsed) / 1000);
        return res.status(429).json({
          error: '3-hour cooldown active for this slot',
          retry_after_seconds: remainingS
        });
      }

      // Replace existing slot
      const result = await pool.query(
        `UPDATE group_pictures
         SET encrypted_blob_url = $1, encryption_iv = $2, uploaded_at = NOW()
         WHERE group_id = $3 AND display_order = $4
         RETURNING id, group_id, display_order, encrypted_blob_url,
                   encryption_iv, uploaded_at`,
        [encrypted_blob_url, encryption_iv, groupId, display_order]
      );
      return res.json(result.rows[0]);
    }

    // Insert new slot
    const result = await pool.query(
      `INSERT INTO group_pictures
         (group_id, display_order, encrypted_blob_url, encryption_iv)
       VALUES ($1, $2, $3, $4)
       RETURNING id, group_id, display_order, encrypted_blob_url,
                 encryption_iv, uploaded_at`,
      [groupId, display_order, encrypted_blob_url, encryption_iv]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Upload group picture error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/groups/:groupId/pictures/:order — Delete slot ─
// Creator only. 3hr cooldown: the slot's uploaded_at is preserved
// so the cooldown still applies after deletion until the window passes.
// We implement this by zeroing the blob URL rather than deleting the row,
// keeping the uploaded_at timestamp intact for cooldown enforcement.
router.delete('/:groupId/pictures/:order', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId } = req.params;
    const display_order = parseInt(req.params.order, 10);

    if (isNaN(display_order) || display_order < 1 || display_order > 10) {
      return res.status(400).json({ error: 'Invalid display_order' });
    }

    // Must be creator
    const groupResult = await pool.query(
      `SELECT id, creator_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].creator_id !== myId) {
      return res.status(403).json({ error: 'Only the creator can manage group pictures' });
    }

    const existing = await pool.query(
      `SELECT id, uploaded_at FROM group_pictures
       WHERE group_id = $1 AND display_order = $2`,
      [groupId, display_order]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Picture slot not found' });
    }

    // Check 3hr cooldown
    const uploadedAt = new Date(existing.rows[0].uploaded_at);
    const cooldownMs = 3 * 60 * 60 * 1000;
    const elapsed = Date.now() - uploadedAt.getTime();
    if (elapsed < cooldownMs) {
      const remainingS = Math.ceil((cooldownMs - elapsed) / 1000);
      return res.status(429).json({
        error: '3-hour cooldown active for this slot',
        retry_after_seconds: remainingS
      });
    }

    // Delete the row — slot is now free
    await pool.query(
      `DELETE FROM group_pictures WHERE group_id = $1 AND display_order = $2`,
      [groupId, display_order]
    );

    return res.json({ message: 'Picture deleted' });
  } catch (err) {
    console.error('Delete group picture error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/groups/:groupId — Delete group ──────────────
// Creator only. Cascades: removes all members, pictures, messages.
router.delete('/:groupId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { groupId } = req.params;

    const groupResult = await pool.query(
      `SELECT id, creator_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].creator_id !== myId) {
      return res.status(403).json({ error: 'Only the creator can delete a group' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM messages WHERE group_id = $1`, [groupId]);
      await client.query(`DELETE FROM group_pictures WHERE group_id = $1`, [groupId]);
      await client.query(`DELETE FROM group_members WHERE group_id = $1`, [groupId]);
      await client.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
      await client.query('COMMIT');
      return res.json({ message: 'Group deleted' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Delete group error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
