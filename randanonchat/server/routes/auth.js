const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const authenticate = require('../middleware/auth');
const pool = require('../db');
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';

// ── Username generation ─────────────────────────────────────
const NOUNS = [
  'Tiger', 'Eagle', 'Whale', 'Falcon', 'Panda', 'Cobra', 'Shark', 'Raven',
  'Bison', 'Otter', 'Viper', 'Crane', 'Moose', 'Hyena', 'Gecko', 'Heron',
  'Llama', 'Dingo', 'Finch', 'Trout', 'Maple', 'Cedar', 'Stone', 'Frost',
  'Storm', 'Cloud', 'Flame', 'River', 'Cliff', 'Coral', 'Ember', 'Steel',
  'Arrow', 'Blade', 'Drift', 'Flint', 'Grove', 'Haven', 'Ivory', 'Jewel',
  'Knoll', 'Lunar', 'Marsh', 'Noble', 'Oasis', 'Pearl', 'Quill', 'Ridge',
  'Slate', 'Thorn'
];

const VERBS = [
  'Runs', 'Soars', 'Dives', 'Leaps', 'Hunts', 'Glows', 'Flies', 'Roams',
  'Howls', 'Darts', 'Swims', 'Rides', 'Burns', 'Fades', 'Grows', 'Hides',
  'Jests', 'Keeps', 'Lifts', 'Mends', 'Nears', 'Opens', 'Pulls', 'Reads',
  'Sees', 'Turns', 'Views', 'Walks', 'Yells', 'Zips', 'Aims', 'Bends',
  'Calls', 'Draws', 'Earns', 'Finds', 'Gives', 'Holds', 'Inks', 'Joins',
  'Kicks', 'Leans', 'Maps', 'Nods', 'Owns', 'Pays', 'Rests', 'Sings',
  'Taps', 'Wades'
];

function generateUsername() {
  const noun = NOUNS[crypto.randomInt(NOUNS.length)];
  const verb = VERBS[crypto.randomInt(VERBS.length)];
  const num = crypto.randomInt(10000, 99999);
  return `${noun}${verb}${num}`;
}

// ── Password validation ─────────────────────────────────────
const VALID_GENDERS = ['m', 'f', 'trans', 'other'];
const VALID_LOCATIONS = ['usa', 'canada', 'eu', 'other'];

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 30) {
    return 'Password must be at least 30 characters';
  }

  const letters = (password.match(/[a-zA-Z]/g) || []).length;
  const numbers = (password.match(/[0-9]/g) || []).length;
  const symbols = (password.match(/[^a-zA-Z0-9]/g) || []).length;

  if (letters < 5) return 'Password must contain at least 5 letters';
  if (numbers < 5) return 'Password must contain at least 5 numbers';
  if (symbols < 5) return 'Password must contain at least 5 symbols';

  return null;
}

// ── POST /api/auth/signup ───────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { password, age, gender, location, public_key, age_confirmed, device_fingerprint } = req.body;

    // Validate age gate
    if (!age_confirmed) {
      return res.status(400).json({ error: 'You must confirm you are 18 or older' });
    }

    // Validate password
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    // Validate age
    if (!Number.isInteger(age) || age < 18 || age > 100) {
      return res.status(400).json({ error: 'Age must be between 18 and 100' });
    }

    // Validate gender
    if (!VALID_GENDERS.includes(gender)) {
      return res.status(400).json({ error: 'Gender must be one of: m, f, trans, other' });
    }

    // Validate location
    if (!VALID_LOCATIONS.includes(location)) {
      return res.status(400).json({ error: 'Location must be one of: usa, canada, eu, other' });
    }

    // Validate public key
    if (!public_key || typeof public_key !== 'string') {
      return res.status(400).json({ error: 'Public key is required' });
    }

    // Hash password with Argon2id (OWASP: 64MB memory, 3 iterations)
    const password_hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64MB
      timeCost: 3,
      parallelism: 1
    });

    // Generate unique username — retry up to 10x on collision
    let username;
    let inserted = false;

    for (let attempt = 0; attempt < 10; attempt++) {
      username = generateUsername();

      try {
        const fingerprints = device_fingerprint ? JSON.stringify([device_fingerprint]) : '[]';

        const result = await pool.query(
          `INSERT INTO users (username, password_hash, public_key, age, gender, location, device_fingerprints)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, username`,
          [username, password_hash, public_key, age, gender, location, fingerprints]
        );

        const user = result.rows[0];

        const token = jwt.sign(
          { id: user.id, username: user.username },
          JWT_SECRET,
          { expiresIn: JWT_EXPIRY }
        );

        inserted = true;
        return res.status(201).json({ token, id: user.id, username: user.username });
      } catch (err) {
        // 23505 = unique_violation — username collision, retry
        if (err.code === '23505' && err.constraint && err.constraint.includes('username')) {
          continue;
        }
        throw err;
      }
    }

    if (!inserted) {
      return res.status(503).json({ error: 'Could not generate unique username, please try again' });
    }
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/login ────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password, device_fingerprint } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await pool.query(
      'SELECT id, username, password_hash, ban_type, device_fingerprints FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];

    const valid = await argon2.verify(user.password_hash, password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Track device fingerprint
    if (device_fingerprint) {
      const fingerprints = user.device_fingerprints || [];
      if (!fingerprints.includes(device_fingerprint)) {
        fingerprints.push(device_fingerprint);
        await pool.query(
          'UPDATE users SET device_fingerprints = $1 WHERE id = $2',
          [JSON.stringify(fingerprints), user.id]
        );
      }
    }

    // Shadow ban: fake success — user never knows they are banned
    // Log the login attempt silently, then return a valid-looking token
    if (user.ban_type === 'shadow') {
      if (device_fingerprint) {
        console.log(`Shadow-banned login: user=${user.id} fingerprint=${device_fingerprint}`);
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, shadow_banned: true },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      );

      return res.json({ token, id: user.id, username: user.username });
    }

    // Permanent ban: reject outright
    if (user.ban_type === 'permanent') {
      return res.status(403).json({ error: 'Account suspended' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    return res.json({ token, id: user.id, username: user.username });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/auth/me ────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, public_key, age, gender, location,
              tier, sub_expiry, diamonds, daily_random_count,
              random_allowance, last_random_reset, purchased_features,
              age_filter_min, age_filter_max, gender_filter,
              location_filter, randoms_enabled, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Get me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
