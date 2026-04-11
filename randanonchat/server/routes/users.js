const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const pool = require('../db');

// ── GET /api/users/search?q= ─────────────────────────────────
// Username format: [Noun][Verb][12345] e.g. TigerRuns48291
// Two input boxes in the UI (left = Name, right = #####).
// The client sends whichever box(es) the user filled as a single
// query string. Server detects mode from the content:
//
//   All digits  → right box only  → match numeric suffix
//   All letters → left box only   → match noun+verb prefix exactly
//   Mixed       → both boxes      → match full username exactly
//
// Returns username only — no profile info, no pictures, no IDs.
// Privacy: max 5 results for number search, max 3 for all others.
// Requires auth so anonymous callers cannot enumerate usernames.
router.get('/search', authenticate, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();

    if (!q) {
      return res.status(400).json({ error: 'q is required' });
    }

    // Usernames contain only letters and digits — reject anything else
    // before using q in a regex pattern.
    if (!/^[A-Za-z0-9]+$/.test(q)) {
      return res.status(400).json({ error: 'Invalid search query' });
    }

    const isAllDigits  = /^\d+$/.test(q);
    const isAllLetters = /^[A-Za-z]+$/.test(q);

    let result;

    if (isAllDigits) {
      // Right box: numeric suffix search.
      // "48291" matches TigerRuns48291, CobraLeaps48291, etc.
      // Multiple users can share the same number across different
      // noun+verb combinations — up to 5 returned.
      // ~* is PostgreSQL case-insensitive regex match.
      result = await pool.query(
        `SELECT username FROM users
         WHERE username ~* ('^[A-Za-z]+' || $1 || '$')
         LIMIT 5`,
        [q]
      );
    } else if (isAllLetters) {
      // Left box: noun+verb prefix exact match.
      // "TigerRuns" matches TigerRuns48291, TigerRuns12345, etc.
      // The regex enforces that only digits follow — no partial
      // prefix matches like "Tiger" matching "TigerRuns48291".
      result = await pool.query(
        `SELECT username FROM users
         WHERE username ~* ('^' || $1 || '[0-9]+$')
         LIMIT 3`,
        [q]
      );
    } else {
      // Both boxes: full username exact match (case-insensitive).
      // "TigerRuns48291" → at most one result.
      result = await pool.query(
        `SELECT username FROM users
         WHERE LOWER(username) = LOWER($1)
         LIMIT 3`,
        [q]
      );
    }

    return res.json({ results: result.rows });
  } catch (err) {
    console.error('User search error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
