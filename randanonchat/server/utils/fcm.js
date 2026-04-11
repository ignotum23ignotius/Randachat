// ── FCM push notification utility ────────────────────────────
// Sends a silent data-only push via FCM HTTP v1 API.
// Auth uses GCP Application Default Credentials obtained from
// the GCP metadata server — no key file or env var required.
// The VM service account must have the Firebase Cloud Messaging
// API Admin role (already granted per spec).
//
// Spec:
//   - Firebase project: development-492316
//   - FCM endpoint: https://fcm.googleapis.com/v1/projects/development-492316/messages:send
//   - Payload: data-only (silent) — single key "symbol" = "🜃"
//   - No notification object — Android handles silently

'use strict';

const https = require('https');

const FCM_PROJECT_ID = 'development-492316';
const FCM_ENDPOINT   = `/v1/projects/${FCM_PROJECT_ID}/messages:send`;
const FCM_HOSTNAME   = 'fcm.googleapis.com';

// Fetch a short-lived access token from the GCP metadata server.
// This works automatically on any GCP VM with a service account attached.
// Scope required: https://www.googleapis.com/auth/firebase.messaging
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'metadata.google.internal',
      path: '/computeMetadata/v1/instance/service-accounts/default/token',
      method: 'GET',
      headers: {
        'Metadata-Flavor': 'Google'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            resolve(parsed.access_token);
          } else {
            reject(new Error(`Metadata server returned no access_token: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse metadata server response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Send a silent push notification to a single FCM token.
// Payload is data-only — no notification object — so Android
// delivers silently and the app handles it on next open.
//
// Returns a resolved Promise on success (including 200 OK from FCM).
// Throws on network error or non-200 response from FCM.
async function sendPushNotification(pushToken) {
  const accessToken = await getAccessToken();

  const body = JSON.stringify({
    message: {
      token: pushToken,
      data: {
        symbol: '🜃'
      },
      android: {
        priority: 'normal'
      }
    }
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: FCM_HOSTNAME,
      path: FCM_ENDPOINT,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`FCM error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { sendPushNotification };
