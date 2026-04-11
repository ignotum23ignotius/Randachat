const express = require('express');
const router = express.Router();
const https = require('https');
const authenticate = require('../middleware/auth');
const pool = require('../db');

// ── Google Play Billing verification ────────────────────────
// All billing logic lives SERVER-SIDE only (spec requirement).
// Client sends purchase token; server verifies with Google Play
// Developer API before crediting anything.
//
// Requires GOOGLE_SERVICE_ACCOUNT_JSON env var (service account
// with androidpublisher scope) or GOOGLE_PLAY_ACCESS_TOKEN for
// simpler setups. We use the Google Play Developer API v3:
//   GET https://androidpublisher.googleapis.com/androidpublisher/v3/
//     applications/{packageName}/purchases/products/{productId}/
//     tokens/{token}
//   GET .../purchases/subscriptions/{productId}/tokens/{token}

const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.randanonchat';

// Fetch a Google API access token from a service account JSON.
// Returns a Bearer token string.
async function getGoogleAccessToken() {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var not set');
  }

  const serviceAccount = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  // Build JWT manually (no external dep — base64url + RSA-SHA256 via built-in crypto)
  const crypto = require('crypto');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  // Exchange JWT for access token
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error(`Token exchange failed: ${data}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Verify a one-time product purchase with Google Play.
// Returns the purchase object or throws.
async function verifyProductPurchase(productId, purchaseToken) {
  const accessToken = await getGoogleAccessToken();
  const path =
    `/androidpublisher/v3/applications/${PACKAGE_NAME}` +
    `/purchases/products/${productId}/tokens/${purchaseToken}`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'androidpublisher.googleapis.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`Google Play error ${res.statusCode}: ${data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Verify a subscription purchase with Google Play.
// Returns the subscriptionPurchase object or throws.
async function verifySubscriptionPurchase(productId, purchaseToken) {
  const accessToken = await getGoogleAccessToken();
  const path =
    `/androidpublisher/v3/applications/${PACKAGE_NAME}` +
    `/purchases/subscriptions/${productId}/tokens/${purchaseToken}`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'androidpublisher.googleapis.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`Google Play error ${res.statusCode}: ${data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Acknowledge a one-time product purchase (required by Google Play
// within 3 days or it auto-refunds).
async function acknowledgePurchase(productId, purchaseToken) {
  const accessToken = await getGoogleAccessToken();
  const path =
    `/androidpublisher/v3/applications/${PACKAGE_NAME}` +
    `/purchases/products/${productId}/tokens/${purchaseToken}:acknowledge`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'androidpublisher.googleapis.com',
      path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Length': 0
      }
    };

    const req = https.request(options, (res) => {
      // 204 No Content = success
      res.resume();
      res.on('end', () => {
        if (res.statusCode === 204 || res.statusCode === 200) resolve();
        else reject(new Error(`Acknowledge failed: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Product catalogue ────────────────────────────────────────
// product_id strings must match Google Play Console exactly.
//
// Diamond bundles (one-time):
//   diamonds_100   $1.00  → 100💎
//   diamonds_500   $5.00  → 500💎
//   diamonds_1000  $10.00 → 1000💎
//   diamonds_2100  $20.00 → 2100💎  (+100 bonus)
//   diamonds_5400  $50.00 → 5400💎  (+400 bonus)
//   diamonds_11000 $100.00→ 11000💎 (+1000 bonus)
//   diamonds_24000 $200.00→ 24000💎 (+4000 bonus)
//
// Random bundles (one-time) — cost is diamonds, but purchased via
// Play as IAPs that credit randoms + optional filter:
//   randoms_50            100💎  $1.00
//   randoms_100           190💎  $2.00
//   randoms_250           450💎  $3.00
//   randoms_50_filters    200💎  $2.00
//   randoms_100_filters   380💎  $4.00
//   randoms_250_filters   900💎  $6.00
//
// Subscription (recurring):
//   sub_monthly           1000💎 $10.00/month
//
// Micropayment unlocks (one-time, deducted from diamond balance):
//   These are NOT Google Play products — they are spent from
//   the user's existing diamond balance in-app.

const DIAMOND_PRODUCTS = {
  diamonds_100:   { diamonds: 100,   usd: 1.00 },
  diamonds_500:   { diamonds: 500,   usd: 5.00 },
  diamonds_1000:  { diamonds: 1000,  usd: 10.00 },
  diamonds_2100:  { diamonds: 2100,  usd: 20.00 },
  diamonds_5400:  { diamonds: 5400,  usd: 50.00 },
  diamonds_11000: { diamonds: 11000, usd: 100.00 },
  diamonds_24000: { diamonds: 24000, usd: 200.00 }
};

const RANDOM_PRODUCTS = {
  randoms_50:           { randoms: 50,  diamonds: 100, usd: 1.00,  filters: false },
  randoms_100:          { randoms: 100, diamonds: 190, usd: 2.00,  filters: false },
  randoms_250:          { randoms: 250, diamonds: 450, usd: 3.00,  filters: false },
  randoms_50_filters:   { randoms: 50,  diamonds: 200, usd: 2.00,  filters: true  },
  randoms_100_filters:  { randoms: 100, diamonds: 380, usd: 4.00,  filters: true  },
  randoms_250_filters:  { randoms: 250, diamonds: 900, usd: 6.00,  filters: true  }
};

const SUBSCRIPTION_PRODUCTS = {
  sub_monthly: { usd: 10.00 }
};

// Micropayment unlock costs (diamonds spent from balance)
const UNLOCK_COSTS = {
  filter_unlock:    100,  // age + gender filters together
  profile_pic_slot: 30,   // +1 profile picture slot
  extra_group:      200,  // +1 group
  extra_member:     50    // +1 member slot per group
};

// ── POST /api/payments/purchase/diamonds ────────────────────
// Verify a diamond bundle purchase from Google Play.
// Body: { product_id, purchase_token, order_id }
router.post('/purchase/diamonds', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { product_id, purchase_token, order_id } = req.body;

    if (!product_id || !purchase_token || !order_id) {
      return res.status(400).json({
        error: 'product_id, purchase_token, and order_id are required'
      });
    }

    const catalogue = DIAMOND_PRODUCTS[product_id];
    if (!catalogue) {
      return res.status(400).json({ error: 'Unknown product_id' });
    }

    // Idempotency: reject already-processed order
    const existing = await pool.query(
      `SELECT id, status FROM purchases WHERE order_id = $1`,
      [order_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Order already processed' });
    }

    // Verify with Google Play
    let receiptData;
    try {
      receiptData = await verifyProductPurchase(product_id, purchase_token);
    } catch (err) {
      console.error('Google Play verification failed:', err);
      return res.status(402).json({ error: 'Purchase verification failed' });
    }

    // purchaseState 0 = purchased, 1 = cancelled, 2 = pending
    if (receiptData.purchaseState !== 0) {
      return res.status(402).json({ error: 'Purchase not in completed state' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Record purchase
      await client.query(
        `INSERT INTO purchases
           (user_id, order_id, product_id, purchase_token,
            diamonds_amount, usd_amount, receipt_data, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
        [
          myId, order_id, product_id, purchase_token,
          catalogue.diamonds, catalogue.usd,
          JSON.stringify(receiptData)
        ]
      );

      // Credit diamonds
      await client.query(
        `UPDATE users SET diamonds = diamonds + $1 WHERE id = $2`,
        [catalogue.diamonds, myId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Acknowledge purchase (must happen within 3 days or Google auto-refunds)
    try {
      await acknowledgePurchase(product_id, purchase_token);
    } catch (err) {
      // Log but don't fail the response — diamonds already credited.
      // A retry job should handle unacknowledged purchases in production.
      console.error('Acknowledge failed (non-fatal):', err);
    }

    const updated = await pool.query(
      `SELECT diamonds FROM users WHERE id = $1`,
      [myId]
    );

    return res.json({
      message: `${catalogue.diamonds} diamonds credited`,
      diamonds_credited: catalogue.diamonds,
      diamonds_balance: updated.rows[0].diamonds
    });
  } catch (err) {
    console.error('Diamond purchase error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/payments/purchase/randoms ─────────────────────
// Verify a random bundle purchase from Google Play.
// Credits randoms to random_allowance and optionally unlocks filters
// as a permanent feature in purchased_features JSONB.
// Body: { product_id, purchase_token, order_id }
router.post('/purchase/randoms', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { product_id, purchase_token, order_id } = req.body;

    if (!product_id || !purchase_token || !order_id) {
      return res.status(400).json({
        error: 'product_id, purchase_token, and order_id are required'
      });
    }

    const catalogue = RANDOM_PRODUCTS[product_id];
    if (!catalogue) {
      return res.status(400).json({ error: 'Unknown product_id' });
    }

    const existing = await pool.query(
      `SELECT id FROM purchases WHERE order_id = $1`,
      [order_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Order already processed' });
    }

    let receiptData;
    try {
      receiptData = await verifyProductPurchase(product_id, purchase_token);
    } catch (err) {
      console.error('Google Play verification failed:', err);
      return res.status(402).json({ error: 'Purchase verification failed' });
    }

    if (receiptData.purchaseState !== 0) {
      return res.status(402).json({ error: 'Purchase not in completed state' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO purchases
           (user_id, order_id, product_id, purchase_token,
            diamonds_amount, usd_amount, receipt_data, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
        [
          myId, order_id, product_id, purchase_token,
          catalogue.diamonds, catalogue.usd,
          JSON.stringify(receiptData)
        ]
      );

      // Add randoms to the user's allowance (permanent — "Keep What You Earned")
      await client.query(
        `UPDATE users SET random_allowance = random_allowance + $1 WHERE id = $2`,
        [catalogue.randoms, myId]
      );

      // If this bundle includes filters, mark as permanent unlock
      if (catalogue.filters) {
        await client.query(
          `UPDATE users
           SET purchased_features = purchased_features || '{"filter_unlock": true}'::jsonb
           WHERE id = $1`,
          [myId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    try {
      await acknowledgePurchase(product_id, purchase_token);
    } catch (err) {
      console.error('Acknowledge failed (non-fatal):', err);
    }

    return res.json({
      message: `${catalogue.randoms} randoms credited${catalogue.filters ? ' with filter unlock' : ''}`,
      randoms_credited: catalogue.randoms,
      filter_unlocked: catalogue.filters
    });
  } catch (err) {
    console.error('Randoms purchase error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/payments/purchase/subscription ────────────────
// Verify a subscription purchase from Google Play.
// Sets tier='subscribed' and sub_expiry from Google's expiry time.
// "Keep What You Earned": downgrade is handled at access-check time
// in routes that enforce tier limits — nothing is stripped here.
// Body: { product_id, purchase_token, order_id }
router.post('/purchase/subscription', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { product_id, purchase_token, order_id } = req.body;

    if (!product_id || !purchase_token || !order_id) {
      return res.status(400).json({
        error: 'product_id, purchase_token, and order_id are required'
      });
    }

    if (!SUBSCRIPTION_PRODUCTS[product_id]) {
      return res.status(400).json({ error: 'Unknown subscription product_id' });
    }

    const existing = await pool.query(
      `SELECT id FROM purchases WHERE order_id = $1`,
      [order_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Order already processed' });
    }

    let receiptData;
    try {
      receiptData = await verifySubscriptionPurchase(product_id, purchase_token);
    } catch (err) {
      console.error('Google Play subscription verification failed:', err);
      return res.status(402).json({ error: 'Subscription verification failed' });
    }

    // expiryTimeMillis is a string in the Google response
    const expiryMs = parseInt(receiptData.expiryTimeMillis, 10);
    if (!expiryMs || isNaN(expiryMs)) {
      return res.status(402).json({ error: 'Invalid subscription expiry from Google' });
    }
    const subExpiry = new Date(expiryMs);

    // paymentState: 1 = received, 2 = free trial — both are active
    // 0 = pending, null = cancelled but not yet expired
    const paymentState = receiptData.paymentState;
    if (paymentState !== 1 && paymentState !== 2) {
      return res.status(402).json({ error: 'Subscription payment not confirmed' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO purchases
           (user_id, order_id, product_id, purchase_token,
            diamonds_amount, usd_amount, receipt_data, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
        [
          myId, order_id, product_id, purchase_token,
          0,    // subscriptions don't credit diamonds directly
          SUBSCRIPTION_PRODUCTS[product_id].usd,
          JSON.stringify(receiptData)
        ]
      );

      // Activate subscription
      await client.query(
        `UPDATE users SET tier = 'subscribed', sub_expiry = $1 WHERE id = $2`,
        [subExpiry, myId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.json({
      message: 'Subscription activated',
      sub_expiry: subExpiry.toISOString()
    });
  } catch (err) {
    console.error('Subscription purchase error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/payments/subscription/renew ───────────────────
// Called by Google Play Real-Time Developer Notifications (RTDN)
// webhook, or by the client after a successful renewal.
// Updates sub_expiry with the new expiry from Google.
// Body: { product_id, purchase_token }
router.post('/subscription/renew', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { product_id, purchase_token } = req.body;

    if (!product_id || !purchase_token) {
      return res.status(400).json({
        error: 'product_id and purchase_token are required'
      });
    }

    if (!SUBSCRIPTION_PRODUCTS[product_id]) {
      return res.status(400).json({ error: 'Unknown subscription product_id' });
    }

    let receiptData;
    try {
      receiptData = await verifySubscriptionPurchase(product_id, purchase_token);
    } catch (err) {
      console.error('Google Play renewal verification failed:', err);
      return res.status(402).json({ error: 'Renewal verification failed' });
    }

    const expiryMs = parseInt(receiptData.expiryTimeMillis, 10);
    if (!expiryMs || isNaN(expiryMs)) {
      return res.status(402).json({ error: 'Invalid expiry from Google' });
    }
    const subExpiry = new Date(expiryMs);

    await pool.query(
      `UPDATE users SET tier = 'subscribed', sub_expiry = $1 WHERE id = $2`,
      [subExpiry, myId]
    );

    return res.json({
      message: 'Subscription renewed',
      sub_expiry: subExpiry.toISOString()
    });
  } catch (err) {
    console.error('Subscription renewal error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/payments/subscription/cancel ──────────────────
// Called when the user cancels or Google notifies of expiry.
// Reverts tier to 'free'. "Keep What You Earned" is enforced
// at access-check time in feature routes — nothing is wiped here.
// Randoms revert to 25/day and filters revert to location-only
// because those are tier-gated, not stored as permanent unlocks.
// Body: { purchase_token, product_id } (for final verification)
router.post('/subscription/cancel', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    // "Keep What You Earned" rule:
    // Groups stay, profile pics stay, group members stay.
    // Randoms reverts to base 25/day allowance (random_allowance
    // purchased separately via random bundles is kept).
    // Filters revert to location-only (age/gender are sub-only
    // unless purchased via filter_unlock micropayment).
    await pool.query(
      `UPDATE users
       SET tier = 'free',
           sub_expiry = NULL
       WHERE id = $1`,
      [myId]
    );

    return res.json({ message: 'Subscription cancelled. Existing groups, pictures, and members are kept.' });
  } catch (err) {
    console.error('Subscription cancel error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/payments/unlock ────────────────────────────────
// Spend diamonds from balance to permanently unlock a feature.
// These are NOT Google Play transactions — diamonds already in
// the user's balance are spent directly.
//
// unlock_type values:
//   filter_unlock    — 100💎 — age + gender filters permanently
//   profile_pic_slot — 30💎  — +1 profile picture slot
//   extra_group      — 200💎 — +1 group slot
//   extra_member     — 50💎  — +1 member slot per group
//
// Body: { unlock_type }
router.post('/unlock', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { unlock_type } = req.body;

    if (!unlock_type) {
      return res.status(400).json({ error: 'unlock_type is required' });
    }

    const cost = UNLOCK_COSTS[unlock_type];
    if (cost === undefined) {
      return res.status(400).json({
        error: `Unknown unlock_type. Valid values: ${Object.keys(UNLOCK_COSTS).join(', ')}`
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Read current balance and features with row lock
      const userResult = await client.query(
        `SELECT diamonds, purchased_features FROM users WHERE id = $1 FOR UPDATE`,
        [myId]
      );
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      const { diamonds, purchased_features } = userResult.rows[0];
      const features = purchased_features || {};

      if (diamonds < cost) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: `Insufficient diamonds. Need ${cost}💎, have ${diamonds}💎.`
        });
      }

      // Build the updated feature value
      let updatedFeatures;
      switch (unlock_type) {
        case 'filter_unlock':
          // One-time toggle — idempotent
          updatedFeatures = { ...features, filter_unlock: true };
          break;
        case 'profile_pic_slot':
          // Each purchase adds 1 extra slot (stacks)
          updatedFeatures = {
            ...features,
            extra_profile_pics: (features.extra_profile_pics || 0) + 1
          };
          break;
        case 'extra_group':
          updatedFeatures = {
            ...features,
            extra_groups: (features.extra_groups || 0) + 1
          };
          break;
        case 'extra_member':
          updatedFeatures = {
            ...features,
            extra_members: (features.extra_members || 0) + 1
          };
          break;
        default:
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Unknown unlock_type' });
      }

      // Deduct diamonds and apply unlock atomically
      await client.query(
        `UPDATE users
         SET diamonds = diamonds - $1,
             purchased_features = $2::jsonb
         WHERE id = $3`,
        [cost, JSON.stringify(updatedFeatures), myId]
      );

      await client.query('COMMIT');

      const updated = await pool.query(
        `SELECT diamonds, purchased_features FROM users WHERE id = $1`,
        [myId]
      );

      return res.json({
        message: `${unlock_type} unlocked`,
        diamonds_spent: cost,
        diamonds_balance: updated.rows[0].diamonds,
        purchased_features: updated.rows[0].purchased_features
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Unlock error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/payments/balance ────────────────────────────────
// Return the caller's current diamond balance, tier, and purchased features.
router.get('/balance', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    const result = await pool.query(
      `SELECT diamonds, tier, sub_expiry, purchased_features,
              random_allowance, daily_random_count, last_random_reset
       FROM users WHERE id = $1`,
      [myId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const row = result.rows[0];
    const isSubscribed =
      row.tier === 'subscribed' &&
      row.sub_expiry &&
      new Date(row.sub_expiry) > new Date();

    return res.json({
      diamonds: row.diamonds,
      tier: row.tier,
      is_subscribed: isSubscribed,
      sub_expiry: row.sub_expiry,
      purchased_features: row.purchased_features,
      random_allowance: row.random_allowance,
      daily_random_count: row.daily_random_count,
      last_random_reset: row.last_random_reset
    });
  } catch (err) {
    console.error('Balance error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/payments/history ────────────────────────────────
// Return the caller's purchase history.
router.get('/history', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    const result = await pool.query(
      `SELECT id, order_id, product_id, diamonds_amount, usd_amount,
              status, created_at
       FROM purchases
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [myId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('Purchase history error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/payments/catalogue ─────────────────────────────
// Return all product definitions so the client can display prices.
// Billing logic stays server-side; client only renders these values.
router.get('/catalogue', authenticate, async (_req, res) => {
  return res.json({
    diamond_bundles: DIAMOND_PRODUCTS,
    random_bundles: RANDOM_PRODUCTS,
    subscriptions: SUBSCRIPTION_PRODUCTS,
    unlock_costs: UNLOCK_COSTS
  });
});

// ── POST /api/payments/generate-key ─────────────────────────
// Admin-only endpoint protected by X-Cron-Secret header.
// Generates a subscription key in the format:
//   RANDA-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
// where each X is a random uppercase alphanumeric character.
// Stores the key in subscription_keys and returns it.
router.post('/generate-key', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const crypto = require('crypto');
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    // Generate 6 groups of 4 random alphanumeric uppercase characters
    const groups = [];
    for (let g = 0; g < 6; g++) {
      let group = '';
      const bytes = crypto.randomBytes(4);
      for (let i = 0; i < 4; i++) {
        group += CHARS[bytes[i] % CHARS.length];
      }
      groups.push(group);
    }
    const key = `RANDA-${groups.join('-')}`;

    await pool.query(
      `INSERT INTO subscription_keys (key) VALUES ($1)`,
      [key]
    );

    return res.status(201).json({ key });
  } catch (err) {
    console.error('Generate key error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/payments/redeem-key ────────────────────────────
// Authenticated user submits a subscription key.
// Validates the key exists and has not been redeemed, then
// grants 1 month subscription and marks the key as redeemed
// atomically. "Keep What You Earned" applies — downgrade is
// handled at access-check time; nothing is stripped on expiry.
// Body: { key }
router.post('/redeem-key', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { key } = req.body;

    if (!key || typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'key is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row so concurrent redemptions cannot race
      const keyResult = await client.query(
        `SELECT id, redeemed_by FROM subscription_keys
         WHERE key = $1 FOR UPDATE`,
        [key.trim()]
      );

      if (keyResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invalid key' });
      }

      if (keyResult.rows[0].redeemed_by !== null) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Key has already been redeemed' });
      }

      // Grant 1 month from now (or extend from current expiry if still active)
      const subExpiry = new Date();
      subExpiry.setMonth(subExpiry.getMonth() + 1);

      await client.query(
        `UPDATE users SET tier = 'subscribed', sub_expiry = $1 WHERE id = $2`,
        [subExpiry, myId]
      );

      await client.query(
        `UPDATE subscription_keys
         SET redeemed_by = $1, redeemed_at = NOW()
         WHERE key = $2`,
        [myId, key.trim()]
      );

      await client.query('COMMIT');

      return res.json({
        message: 'Subscription activated',
        sub_expiry: subExpiry.toISOString()
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Redeem key error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
