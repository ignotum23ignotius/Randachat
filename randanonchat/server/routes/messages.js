const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const authenticate = require('../middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const VALID_BURN_TIMERS = [10, 30, 60, 600, 3600];
const UNOPENED_EXPIRY_HOURS = 24;

// ── WebSocket server ─────────────────────────────────────────
// Created with noServer: true — not bound to a port itself.
// server/index.js attaches it to the HTTP server by passing
// the 'upgrade' event through upgradeHandler (exported below).
const wss = new WebSocketServer({ noServer: true });

// Map<userId, Set<WebSocket>>
// One user can have multiple open connections (multiple tabs).
const clients = new Map();

function register(userId, ws) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
}

function unregister(userId, ws) {
  const sockets = clients.get(userId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) clients.delete(userId);
}

// Send a JSON payload to every open socket for a given userId.
// Silent no-op if the user has no connected sockets.
function sendToUser(userId, payload) {
  const sockets = clients.get(userId);
  if (!sockets || sockets.size === 0) return;
  const data = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// ── Upgrade handler (exported for index.js) ──────────────────
// Verifies the JWT token from the ?token= query parameter before
// allowing the WebSocket handshake. index.js wires this up:
//
//   const { upgradeHandler } = require('./routes/messages');
//   httpServer.on('upgrade', upgradeHandler);
//
// Token is passed by the client as:
//   new WebSocket('ws://host/ws?token=<jwt>')
function upgradeHandler(req, socket, head) {
  // Only handle upgrades targeted at /ws
  const { pathname, searchParams } = new URL(
    req.url,
    `http://${req.headers.host}`
  );
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = searchParams.get('token');
  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Attach userId to req so the 'connection' handler can read it.
  req.userId = payload.id;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

// ── WebSocket connection handler ─────────────────────────────
wss.on('connection', (ws, req) => {
  const userId = req.userId;
  register(userId, ws);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === 'typing') {
      await handleTyping(userId, msg);
    }
  });

  ws.on('close', () => unregister(userId, ws));
  ws.on('error', () => unregister(userId, ws));
});

// ── Typing indicator (WS only) ───────────────────────────────
// Client sends:
//   { type: 'typing', recipient_id: '<uuid>', is_typing: true }
//   { type: 'typing', group_id: '<uuid>',     is_typing: true }
//
// Server pushes to the correct participants only:
//   - DM:    push to the other participant only
//   - Group: push to every active member except the sender
//
// Payload delivered to recipients:
//   { type: 'typing', from: '<userId>', is_typing: bool,
//     conversation: { type: 'dm'|'group', ... } }
async function handleTyping(senderId, msg) {
  const { recipient_id, group_id, is_typing } = msg;

  if (!recipient_id && !group_id) return;

  if (recipient_id) {
    sendToUser(recipient_id, {
      type: 'typing',
      from: senderId,
      is_typing: !!is_typing,
      conversation: { type: 'dm', partner_id: senderId }
    });
    return;
  }

  // Group: resolve active members from DB, push to each (except sender)
  try {
    const result = await pool.query(
      `SELECT user_id FROM group_members
       WHERE group_id = $1 AND removed_at IS NULL AND user_id != $2`,
      [group_id, senderId]
    );
    const payload = {
      type: 'typing',
      from: senderId,
      is_typing: !!is_typing,
      conversation: { type: 'group', group_id }
    };
    for (const row of result.rows) {
      sendToUser(row.user_id, payload);
    }
  } catch (err) {
    console.error('Typing group query error:', err);
  }
}

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
      burn_timer_seconds = null
    } = req.body;

    // Must target exactly one: direct or group
    if ((!recipient_id && !group_id) || (recipient_id && group_id)) {
      return res.status(400).json({ error: 'Provide either recipient_id or group_id, not both' });
    }

    if (!encrypted_content || !encryption_iv) {
      return res.status(400).json({ error: 'encrypted_content and encryption_iv are required' });
    }

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

    const saved = result.rows[0];

    // Push new message to recipient over WebSocket immediately.
    // For direct messages, push to recipient_id.
    // For group messages, push to every active member except the sender.
    if (saved.recipient_id) {
      sendToUser(saved.recipient_id, { type: 'new_message', message: saved });
    } else if (saved.group_id) {
      const members = await pool.query(
        `SELECT user_id FROM group_members
         WHERE group_id = $1 AND removed_at IS NULL AND user_id != $2`,
        [saved.group_id, senderId]
      );
      for (const row of members.rows) {
        sendToUser(row.user_id, { type: 'new_message', message: saved });
      }
    }

    return res.status(201).json(saved);
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

// ── PUT /api/messages/:id/read — Mark as read ────────────────
// Marks the message read in the DB, sets self_destruct_at if
// burn-after-read is enabled, then immediately pushes a
// read_receipt event over WebSocket to the sender.
//
// WS payload delivered to sender:
//   { type: 'read_receipt', message_id, read_by, opened_at,
//     self_destruct_at }
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

    // Only the recipient (or a group member who isn't the sender) can mark read
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

    // Already opened — return current state without pushing a duplicate receipt
    if (msg.read) {
      const current = await pool.query(
        `SELECT id, read, opened_at, self_destruct_at FROM messages WHERE id = $1`,
        [messageId]
      );
      return res.json(current.rows[0]);
    }

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

    const updated = updateResult.rows[0];

    // ── Push read receipt to the sender over WebSocket ────────
    // Fires regardless of whether the sender is currently connected;
    // sendToUser is a silent no-op when they have no open sockets.
    sendToUser(msg.sender_id, {
      type: 'read_receipt',
      message_id: messageId,
      read_by: myId,
      opened_at: updated.opened_at,
      self_destruct_at: updated.self_destruct_at
    });

    return res.json(updated);
  } catch (err) {
    console.error('Mark read error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/messages/expired — Cleanup expired messages ──
router.delete('/expired', authenticate, async (req, res) => {
  try {
    // Fetch unopened expired rows before deleting so we can notify senders.
    const expiredRows = await pool.query(
      `SELECT id, sender_id, recipient_id, group_id FROM messages
       WHERE expires_at IS NOT NULL AND expires_at <= NOW() AND read = FALSE`
    );

    const expiredResult = await pool.query(
      `DELETE FROM messages
       WHERE expires_at IS NOT NULL AND expires_at <= NOW() AND read = FALSE
       RETURNING id`
    );

    for (const row of expiredRows.rows) {
      const payload = { type: 'message_expired', message_id: row.id };
      sendToUser(row.sender_id, payload);
      if (row.recipient_id) {
        sendToUser(row.recipient_id, payload);
      } else if (row.group_id) {
        const members = await pool.query(
          `SELECT user_id FROM group_members
           WHERE group_id = $1 AND removed_at IS NULL`,
          [row.group_id]
        );
        for (const m of members.rows) {
          sendToUser(m.user_id, payload);
        }
      }
    }

    // Fetch burned messages before deleting so we can notify participants.
    const burnedRows = await pool.query(
      `SELECT id, sender_id, recipient_id, group_id FROM messages
       WHERE self_destruct_at IS NOT NULL AND self_destruct_at <= NOW()`
    );

    const burnedResult = await pool.query(
      `DELETE FROM messages
       WHERE self_destruct_at IS NOT NULL AND self_destruct_at <= NOW()
       RETURNING id`
    );

    // Push { type: 'message_destroyed', message_id } to sender and recipient(s).
    for (const row of burnedRows.rows) {
      const payload = { type: 'message_destroyed', message_id: row.id };
      sendToUser(row.sender_id, payload);
      if (row.recipient_id) {
        sendToUser(row.recipient_id, payload);
      } else if (row.group_id) {
        const members = await pool.query(
          `SELECT user_id FROM group_members
           WHERE group_id = $1 AND removed_at IS NULL`,
          [row.group_id]
        );
        for (const m of members.rows) {
          sendToUser(m.user_id, payload);
        }
      }
    }

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
router.get('/inbox', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

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

    return res.json({ direct: dmResult.rows, groups: groupResult.rows });
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

// ── Exports ──────────────────────────────────────────────────
// index.js usage:
//
//   const http = require('http');
//   const { router: messagesRouter, upgradeHandler } = require('./routes/messages');
//   app.use('/api/messages', messagesRouter);
//   const httpServer = http.createServer(app);
//   httpServer.on('upgrade', upgradeHandler);
//   httpServer.listen(PORT);
module.exports = { router, wss, upgradeHandler, sendToUser };
