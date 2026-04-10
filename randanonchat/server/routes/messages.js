const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authenticate = require('../middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const VALID_BURN_TIMERS = [10, 30, 60, 600, 3600];
const UNOPENED_EXPIRY_HOURS = 24;
const IMAGE_SELF_DESTRUCT_SECONDS = 30;

// ── POST /api/messages — Send a message ─────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const senderId = req.user.id;
    const {
      recipient_id,
      group_id,
      encrypted_content,
      encryption_iv,
      burn_after_read = false,
      burn_timer_seconds = null,
      is_image = false
    } = req.body;

    // Must target exactly one: direct or group
    if ((!recipient_id && !group_id) || (recipient_id && group_id)) {
      return res.status(400).json({ error: 'Provide either recipient_id or group_id, not both' });
    }

    if (!encrypted_content || !encryption_iv) {
      return res.status(400).json({ error: 'encrypted_content and encryption_iv are required' });
    }

    // Validate burn timer
    if (burn_after_read && burn_timer_seconds !== null && !VALID_BURN_TIMERS.includes(burn_timer_seconds)) {
      return res.status(400).json({ error: 'burn_timer_seconds must be one of: 10, 30, 60, 600, 3600' });
    }

    // Block check (direct messages only)
    if (recipient_id) {
      const blockCheck = await pool.query(
        `SELECT id FROM blocked_users
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)`,
        [senderId, recipient_id]
      );
      if (blockCheck.rows.length > 0) {
        return res.status(403).json({ error: 'Cannot send message to this user' });
      }
    }

    // Group membership check
    if (group_id) {
      const memberCheck = await pool.query(
        `SELECT id FROM group_members
         WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [group_id, senderId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this group' });
      }
    }

    // Set expiry: 24 hours from now if unopened
    const expiresAt = new Date(Date.now() + UNOPENED_EXPIRY_HOURS * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO messages
         (sender_id, recipient_id, group_id, encrypted_content, encryption_iv,
          burn_after_read, burn_timer_seconds, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, sender_id, recipient_id, group_id, encrypted_content,
                 encryption_iv, burn_after_read, burn_timer_seconds,
                 expires_at, read, created_at`,
      [
        senderId,
        recipient_id || null,
        group_id || null,
        encrypted_content,
        encryption_iv,
        burn_after_read,
        burn_after_read ? burn_timer_seconds : null,
        expiresAt
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Send message error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/messages/conversation/:userId — Direct messages ─
router.get('/conversation/:userId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const otherId = req.params.userId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const before = req.query.before || null;

    let query = `
      SELECT id, sender_id, recipient_id, encrypted_content, encryption_iv,
             burn_after_read, burn_timer_seconds, opened_at, self_destruct_at,
             expires_at, read, created_at
      FROM messages
      WHERE recipient_id IS NOT NULL
        AND ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (self_destruct_at IS NULL OR self_destruct_at > NOW())
    `;
    const params = [myId, otherId];

    if (before) {
      query += ` AND created_at < $${params.length + 1}`;
      params.push(before);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);

    return res.json(result.rows);
  } catch (err) {
    console.error('Get conversation error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/messages/group/:groupId — Group messages ───────
router.get('/group/:groupId', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const groupId = req.params.groupId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const before = req.query.before || null;

    // Verify membership
    const memberCheck = await pool.query(
      `SELECT id FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [groupId, myId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    let query = `
      SELECT id, sender_id, group_id, encrypted_content, encryption_iv,
             burn_after_read, burn_timer_seconds, opened_at, self_destruct_at,
             expires_at, read, created_at
      FROM messages
      WHERE group_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (self_destruct_at IS NULL OR self_destruct_at > NOW())
    `;
    const params = [groupId];

    if (before) {
      query += ` AND created_at < $${params.length + 1}`;
      params.push(before);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);

    return res.json(result.rows);
  } catch (err) {
    console.error('Get group messages error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/messages/:id/read — Mark as read (read receipt) ─
router.put('/:id/read', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const messageId = req.params.id;

    const msgResult = await pool.query(
      `SELECT id, sender_id, recipient_id, group_id, burn_after_read,
              burn_timer_seconds, opened_at, read
       FROM messages WHERE id = $1`,
      [messageId]
    );

    if (msgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const msg = msgResult.rows[0];

    // Only the recipient (or a group member who isn't the sender) can mark as read
    if (msg.recipient_id) {
      if (msg.recipient_id !== myId) {
        return res.status(403).json({ error: 'Not the recipient of this message' });
      }
    } else if (msg.group_id) {
      if (msg.sender_id === myId) {
        return res.status(400).json({ error: 'Cannot mark your own message as read' });
      }
      const memberCheck = await pool.query(
        `SELECT id FROM group_members
         WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [msg.group_id, myId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this group' });
      }
    }

    // Already opened — return current state
    if (msg.read) {
      const current = await pool.query(
        `SELECT id, read, opened_at, self_destruct_at FROM messages WHERE id = $1`,
        [messageId]
      );
      return res.json(current.rows[0]);
    }

    // Set opened_at and self_destruct_at if burn_after_read is enabled
    let selfDestructAt = null;
    if (msg.burn_after_read && msg.burn_timer_seconds) {
      selfDestructAt = new Date(Date.now() + msg.burn_timer_seconds * 1000);
    }

    const updateResult = await pool.query(
      `UPDATE messages
       SET read = TRUE,
           opened_at = NOW(),
           self_destruct_at = $1
       WHERE id = $2
       RETURNING id, read, opened_at, self_destruct_at`,
      [selfDestructAt, messageId]
    );

    return res.json(updateResult.rows[0]);
  } catch (err) {
    console.error('Mark read error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/messages/typing — Typing indicator ────────────
// Client polls or uses WebSockets. This endpoint stores the
// typing state ephemerally — no persistence needed.
const typingState = new Map();

router.post('/typing', authenticate, (req, res) => {
  const { recipient_id, group_id, is_typing } = req.body;

  if (!recipient_id && !group_id) {
    return res.status(400).json({ error: 'Provide recipient_id or group_id' });
  }

  const key = recipient_id
    ? `dm:${[req.user.id, recipient_id].sort().join(':')}`
    : `group:${group_id}`;

  if (!typingState.has(key)) {
    typingState.set(key, {});
  }

  const state = typingState.get(key);

  if (is_typing) {
    state[req.user.id] = Date.now();
  } else {
    delete state[req.user.id];
  }

  return res.json({ ok: true });
});

// ── GET /api/messages/typing/:targetId — Get typing status ──
router.get('/typing/:targetId', authenticate, (req, res) => {
  const targetId = req.params.targetId;
  const type = req.query.type || 'dm'; // dm or group
  const myId = req.user.id;

  const key = type === 'group'
    ? `group:${targetId}`
    : `dm:${[myId, targetId].sort().join(':')}`;

  const state = typingState.get(key) || {};
  const now = Date.now();
  const TYPING_TIMEOUT = 5000; // 5 second timeout

  // Filter out stale typing indicators and exclude self
  const typingUsers = Object.entries(state)
    .filter(([userId, timestamp]) => userId !== myId && now - timestamp < TYPING_TIMEOUT)
    .map(([userId]) => userId);

  return res.json({ typing: typingUsers });
});

// ── DELETE /api/messages/expired — Cleanup expired messages ──
// Called by a server-side cron or scheduled task.
router.delete('/expired', authenticate, async (req, res) => {
  try {
    // Delete messages past their unopened expiry (24 hours)
    const expiredResult = await pool.query(
      `DELETE FROM messages
       WHERE expires_at IS NOT NULL AND expires_at <= NOW() AND read = FALSE
       RETURNING id`
    );

    // Delete messages past their burn self-destruct timer
    const burnedResult = await pool.query(
      `DELETE FROM messages
       WHERE self_destruct_at IS NOT NULL AND self_destruct_at <= NOW()
       RETURNING id`
    );

    return res.json({
      expired_deleted: expiredResult.rowCount,
      burned_deleted: burnedResult.rowCount
    });
  } catch (err) {
    console.error('Cleanup expired error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/messages/inbox — Inbox summary ─────────────────
// Returns the latest message per conversation for the inbox view.
router.get('/inbox', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    // Direct message conversations: latest message per partner
    const dmResult = await pool.query(
      `SELECT DISTINCT ON (partner_id)
              m.id, m.sender_id, m.recipient_id, m.encrypted_content,
              m.encryption_iv, m.burn_after_read, m.burn_timer_seconds,
              m.read, m.created_at,
              CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS partner_id
       FROM messages m
       WHERE m.recipient_id IS NOT NULL
         AND (m.sender_id = $1 OR m.recipient_id = $1)
         AND (m.expires_at IS NULL OR m.expires_at > NOW())
         AND (m.self_destruct_at IS NULL OR m.self_destruct_at > NOW())
       ORDER BY partner_id, m.created_at DESC`,
      [myId]
    );

    // Group conversations: latest message per group the user is a member of
    const groupResult = await pool.query(
      `SELECT DISTINCT ON (m.group_id)
              m.id, m.sender_id, m.group_id, m.encrypted_content,
              m.encryption_iv, m.burn_after_read, m.burn_timer_seconds,
              m.read, m.created_at
       FROM messages m
       INNER JOIN group_members gm ON gm.group_id = m.group_id
       WHERE gm.user_id = $1 AND gm.removed_at IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > NOW())
         AND (m.self_destruct_at IS NULL OR m.self_destruct_at > NOW())
       ORDER BY m.group_id, m.created_at DESC`,
      [myId]
    );

    return res.json({
      direct: dmResult.rows,
      groups: groupResult.rows
    });
  } catch (err) {
    console.error('Inbox error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/messages/:id — Single message detail ───────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const messageId = req.params.id;

    const result = await pool.query(
      `SELECT id, sender_id, recipient_id, group_id, encrypted_content,
              encryption_iv, burn_after_read, burn_timer_seconds,
              opened_at, self_destruct_at, expires_at, read, created_at
       FROM messages WHERE id = $1`,
      [messageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const msg = result.rows[0];

    // Verify access: must be sender, recipient, or group member
    if (msg.recipient_id) {
      if (msg.sender_id !== myId && msg.recipient_id !== myId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } else if (msg.group_id) {
      const memberCheck = await pool.query(
        `SELECT id FROM group_members
         WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [msg.group_id, myId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Check if expired
    if (msg.expires_at && new Date(msg.expires_at) <= new Date() && !msg.read) {
      return res.status(410).json({ error: 'Message has expired' });
    }
    if (msg.self_destruct_at && new Date(msg.self_destruct_at) <= new Date()) {
      return res.status(410).json({ error: 'Message has self-destructed' });
    }

    return res.json(msg);
  } catch (err) {
    console.error('Get message error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
