const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { sendToUser } = require('./messages');
const pool = require('../db');

// ── POST /api/friends/request — Send a friend request ───────
// Creates a pending row. Request NEVER expires — sits until acted on.
// Banner text on their side: "[username] has added you as a friend,
// do you want to add them back?"
router.post('/request', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (user_id === myId) {
      return res.status(400).json({ error: 'Cannot add yourself as a friend' });
    }

    // Check target user exists
    const userCheck = await pool.query(
      'SELECT id, username FROM users WHERE id = $1',
      [user_id]
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if blocked in either direction
    const blockCheck = await pool.query(
      `SELECT id FROM blocked_users
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)`,
      [myId, user_id]
    );
    if (blockCheck.rows.length > 0) {
      return res.status(403).json({ error: 'Cannot send friend request to this user' });
    }

    // Ordered pair for the UNIQUE constraint
    const id1 = myId < user_id ? myId : user_id;
    const id2 = myId < user_id ? user_id : myId;

    // Check if friendship already exists
    const existing = await pool.query(
      `SELECT id, status, requested_by FROM friends
       WHERE user_id_1 = $1 AND user_id_2 = $2`,
      [id1, id2]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];

      if (row.status === 'accepted') {
        return res.status(409).json({ error: 'Already friends' });
      }

      // Pending request exists
      if (row.requested_by === myId) {
        // I already sent a request — nothing to do
        return res.status(409).json({ error: 'Friend request already sent' });
      }

      // They sent the request and now I'm requesting too → mutual accept
      const updated = await pool.query(
        `UPDATE friends SET status = 'accepted' WHERE id = $1
         RETURNING id, user_id_1, user_id_2, status, created_at, updated_at`,
        [row.id]
      );

      return res.json({
        friendship: updated.rows[0],
        mutual: true,
        message: 'Friend request accepted — you are now friends'
      });
    }

    // Create new pending request
    const result = await pool.query(
      `INSERT INTO friends (user_id_1, user_id_2, requested_by, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, user_id_1, user_id_2, requested_by, status, created_at`,
      [id1, id2, myId]
    );

    sendToUser(user_id, { type: 'friend_request', friendship: result.rows[0] });

    return res.status(201).json({
      friendship: result.rows[0],
      mutual: false,
      message: 'Friend request sent'
    });
  } catch (err) {
    console.error('Friend request error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/friends/accept/:friendshipId — Accept request ──
// Mutual accept: moves to Friends tab, removed from random pool
// forever, profile pictures become visible to each other.
router.put('/accept/:friendshipId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const friendshipId = req.params.friendshipId;

    const result = await pool.query(
      `SELECT id, user_id_1, user_id_2, requested_by, status
       FROM friends WHERE id = $1`,
      [friendshipId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Friend request not found' });
    }

    const row = result.rows[0];

    // Must be the OTHER user (not the one who sent the request)
    if (row.requested_by === myId) {
      return res.status(400).json({ error: 'Cannot accept your own request' });
    }

    // Must be involved in the friendship
    if (row.user_id_1 !== myId && row.user_id_2 !== myId) {
      return res.status(403).json({ error: 'Not your friend request' });
    }

    if (row.status === 'accepted') {
      return res.status(409).json({ error: 'Already friends' });
    }

    const updated = await pool.query(
      `UPDATE friends SET status = 'accepted' WHERE id = $1
       RETURNING id, user_id_1, user_id_2, status, created_at, updated_at`,
      [friendshipId]
    );

    sendToUser(row.requested_by, { type: 'friend_accepted', friendship: updated.rows[0] });

    return res.json({
      friendship: updated.rows[0],
      message: 'Friend request accepted — profile pictures are now visible to each other'
    });
  } catch (err) {
    console.error('Accept friend error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/friends/dismiss/:friendshipId — Dismiss request ─
// One-way add: they dismiss → stays in Randoms tab.
// No pending state cluttering Friends tab.
// Request is deleted so it doesn't clutter, but the sender
// can re-send in the future.
router.put('/dismiss/:friendshipId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const friendshipId = req.params.friendshipId;

    const result = await pool.query(
      `SELECT id, user_id_1, user_id_2, requested_by, status
       FROM friends WHERE id = $1`,
      [friendshipId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Friend request not found' });
    }

    const row = result.rows[0];

    // Must be the recipient (not the requester)
    if (row.requested_by === myId) {
      return res.status(400).json({ error: 'Cannot dismiss your own request' });
    }

    if (row.user_id_1 !== myId && row.user_id_2 !== myId) {
      return res.status(403).json({ error: 'Not your friend request' });
    }

    if (row.status === 'accepted') {
      return res.status(400).json({ error: 'Cannot dismiss an accepted friendship' });
    }

    sendToUser(row.requested_by, { type: 'friend_dismissed', friendship_id: friendshipId });

    await pool.query('DELETE FROM friends WHERE id = $1', [friendshipId]);

    return res.json({ message: 'Friend request dismissed' });
  } catch (err) {
    console.error('Dismiss friend error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/friends — List all friends (accepted) ──────────
router.get('/', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    const result = await pool.query(
      `SELECT f.id AS friendship_id, f.created_at AS friends_since,
              u.id, u.username, u.age, u.gender, u.location, u.public_key
       FROM friends f
       INNER JOIN users u ON u.id = CASE
         WHEN f.user_id_1 = $1 THEN f.user_id_2
         ELSE f.user_id_1
       END
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.status = 'accepted'
       ORDER BY f.updated_at DESC`,
      [myId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('List friends error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/friends/pending — List pending requests for me ─
// These are requests OTHER users sent TO me (banner notifications).
// Never expires — sits until acted on.
router.get('/pending', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    const result = await pool.query(
      `SELECT f.id AS friendship_id, f.requested_by, f.created_at,
              u.id, u.username
       FROM friends f
       INNER JOIN users u ON u.id = f.requested_by
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.requested_by != $1
         AND f.status = 'pending'
       ORDER BY f.created_at ASC`,
      [myId]
    );

    const rows = result.rows.map(row => ({
      ...row,
      banner_text: `${row.username} has added you as a friend, do you want to add them back?`
    }));

    return res.json(rows);
  } catch (err) {
    console.error('List pending error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/friends/:userId/pictures — Friend's profile pics ─
// Profile pictures visible ONLY to mutual friends.
// Randoms see nothing — this endpoint enforces that.
router.get('/:userId/pictures', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const targetId = req.params.userId;

    // Allow viewing own pictures
    if (targetId !== myId) {
      const id1 = myId < targetId ? myId : targetId;
      const id2 = myId < targetId ? targetId : myId;

      const friendCheck = await pool.query(
        `SELECT id FROM friends
         WHERE user_id_1 = $1 AND user_id_2 = $2 AND status = 'accepted'`,
        [id1, id2]
      );

      if (friendCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Profile pictures are only visible to friends' });
      }
    }

    const result = await pool.query(
      `SELECT id, display_order, encrypted_blob_url, encryption_iv, uploaded_at
       FROM profile_pictures
       WHERE user_id = $1
       ORDER BY display_order ASC`,
      [targetId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('Get friend pictures error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/friends/:friendshipId — Remove friend ───────
router.delete('/:friendshipId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const friendshipId = req.params.friendshipId;

    const result = await pool.query(
      `SELECT id, user_id_1, user_id_2 FROM friends WHERE id = $1`,
      [friendshipId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    const row = result.rows[0];
    if (row.user_id_1 !== myId && row.user_id_2 !== myId) {
      return res.status(403).json({ error: 'Not your friendship' });
    }

    await pool.query('DELETE FROM friends WHERE id = $1', [friendshipId]);

    return res.json({ message: 'Friend removed' });
  } catch (err) {
    console.error('Remove friend error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════
// Block / Ignore System
// ════════════════════════════════════════════════════════════

// ── POST /api/friends/block — Block or ignore a user ────────
// Block: cannot message at all, ever.
// Ignore: messages go to hidden folder, they don't know.
// Blocked/ignored users are NEVER notified.
router.post('/block', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { user_id, type } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (!['block', 'ignore'].includes(type)) {
      return res.status(400).json({ error: 'type must be "block" or "ignore"' });
    }

    if (user_id === myId) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    // Check target exists
    const userCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1',
      [user_id]
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Upsert: update type if already blocked/ignored
    const result = await pool.query(
      `INSERT INTO blocked_users (blocker_id, blocked_id, type)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id)
       DO UPDATE SET type = $3
       RETURNING id, blocker_id, blocked_id, type, created_at`,
      [myId, user_id, type]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Block user error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/friends/block/:userId — Unblock/unignore ────
// Removal: user manually removes from list in settings.
router.delete('/block/:userId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const targetId = req.params.userId;

    const result = await pool.query(
      `DELETE FROM blocked_users
       WHERE blocker_id = $1 AND blocked_id = $2
       RETURNING id`,
      [myId, targetId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Block/ignore entry not found' });
    }

    return res.json({ message: 'User unblocked' });
  } catch (err) {
    console.error('Unblock user error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/friends/blocked — List blocked/ignored users ───
// Both managed in main app settings.
router.get('/blocked', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    const result = await pool.query(
      `SELECT b.id, b.blocked_id, b.type, b.created_at,
              u.username
       FROM blocked_users b
       INNER JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [myId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('List blocked error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
