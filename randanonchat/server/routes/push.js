const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const pool = require('../db');

// ── POST /api/push/register — Store or refresh a push token ──
// Called on every app open after the client obtains an FCM token.
// Overwrites any existing token for this user so only the most
// recent device/session receives pushes.
// Body: { push_token }
router.post('/register', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { push_token } = req.body;

    if (!push_token || typeof push_token !== 'string' || !push_token.trim()) {
      return res.status(400).json({ error: 'push_token is required' });
    }

    await pool.query(
      `UPDATE users SET push_token = $1 WHERE id = $2`,
      [push_token.trim(), myId]
    );

    return res.json({ message: 'Push token registered' });
  } catch (err) {
    console.error('Push register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/push/register — Clear push token on logout ───
// Called during logout so the device no longer receives pushes
// after the session ends.
router.delete('/register', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    await pool.query(
      `UPDATE users SET push_token = NULL WHERE id = $1`,
      [myId]
    );

    return res.json({ message: 'Push token cleared' });
  } catch (err) {
    console.error('Push clear error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
