const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authenticate = require('../middleware/auth');
const { sendToUser } = require('./messages');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Dynamic window calculation ──────────────────────────────
// Fully self-calibrating — zero hardcoded numbers.

async function getBaseWindow() {
  // Average return interval between consecutive sessions over the last 30 days.
  // Each user's sessions are ordered by started_at; the gap between consecutive
  // sessions is one "return interval."
  const result = await pool.query(`
    SELECT AVG(gap_hours) AS avg_hours
    FROM (
      SELECT
        EXTRACT(EPOCH FROM (
          started_at - LAG(started_at) OVER (PARTITION BY user_id ORDER BY started_at)
        )) / 3600.0 AS gap_hours
      FROM user_sessions
      WHERE started_at >= NOW() - INTERVAL '30 days'
    ) gaps
    WHERE gap_hours IS NOT NULL
  `);

  return result.rows[0].avg_hours;
}

async function getActivityRatio() {
  // Today's DAU vs 30-day average DAU from app_statistics.
  const avgResult = await pool.query(`
    SELECT AVG(daily_active_users) AS avg_dau
    FROM app_statistics
    WHERE stat_date >= CURRENT_DATE - INTERVAL '30 days'
  `);

  const todayResult = await pool.query(`
    SELECT daily_active_users AS today_dau
    FROM app_statistics
    WHERE stat_date = CURRENT_DATE
  `);

  const avgDau = parseFloat(avgResult.rows[0].avg_dau);
  const todayDau = todayResult.rows[0] ? todayResult.rows[0].today_dau : null;

  if (!avgDau || !todayDau) return null;

  return todayDau / avgDau;
}

async function getFinalWindowHours() {
  const baseWindow = await getBaseWindow();
  const activityRatio = await getActivityRatio();

  // If we don't have enough data yet, return null (caller handles fallback)
  if (!baseWindow || !activityRatio) return null;

  // final_window = base_window / activity_ratio
  // High activity → tighter window (fresher matches)
  // Low activity  → wider window  (keeps app usable)
  return baseWindow / activityRatio;
}

// ── Mutual filter matching ──────────────────────────────────
// Both sides must match each other's filters simultaneously.
// "me" is the requesting user, "them" is a candidate row from users table.

function mutualFilterMatch(me, them) {
  // I match THEIR filters?
  if (me.age < them.age_filter_min || me.age > them.age_filter_max) return false;
  if (!them.gender_filter.includes(me.gender)) return false;
  if (!them.location_filter.includes(me.location)) return false;

  // THEY match MY filters?
  if (them.age < me.age_filter_min || them.age > me.age_filter_max) return false;
  if (!me.gender_filter.includes(them.gender)) return false;
  if (!me.location_filter.includes(them.location)) return false;

  return true;
}

// ── Check tier-based filter access ──────────────────────────
// Free tier: location filter only.
// Subscribed / purchased filter unlock: age + gender + location.

function hasFilterAccess(user) {
  if (user.tier === 'subscribed') return true;
  const purchased = user.purchased_features || {};
  if (purchased.filter_unlock) return true;
  return false;
}

// ── GET /api/matching/next — Serve next random match ────────
router.get('/next', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;

    // Fetch requesting user
    const meResult = await pool.query(
      `SELECT id, age, gender, location, tier, randoms_enabled,
              daily_random_count, random_allowance, last_random_reset,
              age_filter_min, age_filter_max, gender_filter, location_filter,
              purchased_features, ban_type
       FROM users WHERE id = $1`,
      [myId]
    );

    if (meResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const me = meResult.rows[0];

    // Shadow-banned users get an empty result (app appears to work)
    if (me.ban_type === 'shadow') {
      return res.json({ match: null, reason: 'no_matches' });
    }

    if (!me.randoms_enabled) {
      return res.status(400).json({ error: 'Randoms are disabled' });
    }

    // Reset daily count if 24 hours have passed
    const lastReset = new Date(me.last_random_reset);
    const hoursSinceReset = (Date.now() - lastReset.getTime()) / (1000 * 60 * 60);
    if (hoursSinceReset >= 24) {
      await pool.query(
        `UPDATE users SET daily_random_count = 0, last_random_reset = NOW() WHERE id = $1`,
        [myId]
      );
      me.daily_random_count = 0;
    }

    // Check daily limit
    if (me.daily_random_count >= me.random_allowance) {
      return res.status(429).json({ error: 'Daily random limit reached', allowance: me.random_allowance });
    }

    // For free tier, restrict filters to location only
    if (!hasFilterAccess(me)) {
      me.age_filter_min = 18;
      me.age_filter_max = 100;
      me.gender_filter = ['m', 'f', 'trans', 'other'];
      // location_filter stays as user set it
    }

    // Calculate dynamic final window
    const finalWindowHours = await getFinalWindowHours();

    // Fetch friend IDs — friends are NEVER served as randoms
    const friendsResult = await pool.query(
      `SELECT CASE WHEN user_id_1 = $1 THEN user_id_2 ELSE user_id_1 END AS friend_id
       FROM friends
       WHERE (user_id_1 = $1 OR user_id_2 = $1)
         AND status = 'accepted'`,
      [myId]
    );
    const friendIds = friendsResult.rows.map(r => r.friend_id);

    // Fetch IDs of randoms with fresh unread messages from them
    const unreadResult = await pool.query(
      `SELECT DISTINCT sender_id
       FROM messages
       WHERE recipient_id = $1 AND read = FALSE
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [myId]
    );
    const freshUnreadIds = unreadResult.rows.map(r => r.sender_id);

    // Blocked users (both directions)
    const blockedResult = await pool.query(
      `SELECT CASE WHEN blocker_id = $1 THEN blocked_id ELSE blocker_id END AS other_id
       FROM blocked_users
       WHERE blocker_id = $1 OR blocked_id = $1`,
      [myId]
    );
    const blockedIds = blockedResult.rows.map(r => r.other_id);

    // Combine all IDs to exclude
    const excludeIds = new Set([myId, ...friendIds, ...freshUnreadIds, ...blockedIds]);

    // Build candidate pool: randoms_enabled, not banned, within dynamic window
    let candidateQuery = `
      SELECT id, age, gender, location,
             age_filter_min, age_filter_max, gender_filter, location_filter,
             tier, purchased_features,
             EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600.0 AS hours_since_online
      FROM users
      WHERE randoms_enabled = TRUE
        AND ban_type = 'none'
        AND id != $1
    `;
    const params = [myId];

    // Apply dynamic window if available
    if (finalWindowHours !== null) {
      params.push(finalWindowHours);
      candidateQuery += ` AND updated_at >= NOW() - ($${params.length} || ' hours')::INTERVAL`;
    }

    candidateQuery += ` ORDER BY updated_at DESC`;

    const candidatesResult = await pool.query(candidateQuery, params);

    // Apply mutual filter matching and exclusions
    let candidates = candidatesResult.rows.filter(candidate => {
      if (excludeIds.has(candidate.id)) return false;

      // For the candidate's filter check, apply their tier restrictions
      const candidateFilters = { ...candidate };
      if (!hasFilterAccess(candidate)) {
        candidateFilters.age_filter_min = 18;
        candidateFilters.age_filter_max = 100;
        candidateFilters.gender_filter = ['m', 'f', 'trans', 'other'];
      }

      return mutualFilterMatch(me, candidateFilters);
    });

    // Sort by recency score (most recent first)
    // recency_score = time_since_last_online / final_window
    // Lower score = more recently online = higher priority
    if (finalWindowHours !== null) {
      candidates.sort((a, b) => {
        const scoreA = a.hours_since_online / finalWindowHours;
        const scoreB = b.hours_since_online / finalWindowHours;
        return scoreA - scoreB;
      });
    }

    let match = null;

    if (candidates.length > 0) {
      // Serve top of list
      match = candidates[0];
    } else {
      // Pool empty → fallback: serve least-recently-seen random
      // (anyone we've chatted with before, preserving chat history)
      const fallbackResult = await pool.query(
        `SELECT DISTINCT
                CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS partner_id
         FROM messages m
         WHERE m.recipient_id IS NOT NULL
           AND (m.sender_id = $1 OR m.recipient_id = $1)
         ORDER BY partner_id`,
        [myId]
      );

      const previousPartnerIds = fallbackResult.rows
        .map(r => r.partner_id)
        .filter(id => !excludeIds.has(id));

      if (previousPartnerIds.length > 0) {
        // Get these users and find the least-recently-seen one
        const fallbackUsers = await pool.query(
          `SELECT id, age, gender, location,
                  age_filter_min, age_filter_max, gender_filter, location_filter,
                  tier, purchased_features,
                  EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600.0 AS hours_since_online
           FROM users
           WHERE id = ANY($1)
             AND randoms_enabled = TRUE
             AND ban_type = 'none'
           ORDER BY updated_at ASC`,
          [previousPartnerIds]
        );

        // Find first that passes mutual filter
        for (const candidate of fallbackUsers.rows) {
          const candidateFilters = { ...candidate };
          if (!hasFilterAccess(candidate)) {
            candidateFilters.age_filter_min = 18;
            candidateFilters.age_filter_max = 100;
            candidateFilters.gender_filter = ['m', 'f', 'trans', 'other'];
          }

          if (mutualFilterMatch(me, candidateFilters)) {
            match = candidate;
            break;
          }
        }
      }
    }

    if (!match) {
      return res.json({ match: null, reason: 'no_matches' });
    }

    // Increment daily random count
    await pool.query(
      `UPDATE users SET daily_random_count = daily_random_count + 1 WHERE id = $1`,
      [myId]
    );

    const matchPayload = {
      id: match.id,
      age: match.age,
      gender: match.gender,
      location: match.location
    };

    // Notify the matched user instantly over WebSocket.
    sendToUser(match.id, { type: 'new_match', match: { id: myId } });

    return res.json({ match: matchPayload });
  } catch (err) {
    console.error('Matching error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/matching/stats — Current algorithm diagnostics ─
router.get('/stats', authenticate, async (req, res) => {
  try {
    const baseWindow = await getBaseWindow();
    const activityRatio = await getActivityRatio();
    const finalWindowHours = baseWindow && activityRatio
      ? baseWindow / activityRatio
      : null;

    return res.json({
      base_window_hours: baseWindow,
      activity_ratio: activityRatio,
      final_window_hours: finalWindowHours
    });
  } catch (err) {
    console.error('Matching stats error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
