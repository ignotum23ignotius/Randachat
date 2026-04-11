const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const pool = require('../db');

// ── Image storage overview ────────────────────────────────────
// All image processing (CSAM check, EXIF strip, crop, filter,
// text overlay, encryption) is CLIENT-SIDE only.
// The server never sees plaintext image data — it stores and
// serves encrypted blobs only.
//
// Hybrid encryption (per spec):
//   - Client encrypts the image blob with a random symmetric key
//     via crypto_secretbox (encrypted_blob_url = GCS URL of result)
//   - Client seals the symmetric key to the recipient's public key
//     via crypto_box_seal (sealed_key field)
//   - For groups: one blob, sealed_key per member (handled client-side)
//
// 40MB limit is enforced here on the base64/binary body size.
// Image expiry and self-destruct are handled by messages.js.

const MAX_BLOB_BYTES = 40 * 1024 * 1024; // 40MB

// ── POST /api/images/upload — Store an encrypted blob ────────
// Client has already:
//   1. Run CSAM hash check
//   2. Stripped EXIF
//   3. Applied crop / filter / text overlay
//   4. Encrypted the result with a random symmetric key
//   5. Sealed the symmetric key to the recipient's public key
//
// Body:
//   encrypted_blob  — base64-encoded encrypted image bytes
//   encryption_iv   — base64-encoded nonce used for crypto_secretbox
//   sealed_key      — base64-encoded symmetric key sealed to recipient
//   recipient_id    — UUID of recipient (null for group)
//   group_id        — UUID of group    (null for DM)
//
// Returns a record with a server-assigned id that the client
// embeds in the message's encrypted_content so the recipient
// can fetch it via GET /api/images/:id.
router.post('/upload', authenticate, async (req, res) => {
  try {
    const uploaderId = req.user.id;
    const { encrypted_blob, encryption_iv, sealed_key, recipient_id, group_id } = req.body;

    if (!encrypted_blob || !encryption_iv || !sealed_key) {
      return res.status(400).json({
        error: 'encrypted_blob, encryption_iv, and sealed_key are required'
      });
    }

    if ((!recipient_id && !group_id) || (recipient_id && group_id)) {
      return res.status(400).json({
        error: 'Provide either recipient_id or group_id, not both'
      });
    }

    // 40MB limit — check decoded byte size of the base64 blob
    const blobBytes = Math.floor((encrypted_blob.length * 3) / 4);
    if (blobBytes > MAX_BLOB_BYTES) {
      return res.status(413).json({
        error: 'Image exceeds 40MB limit'
      });
    }

    // Block check (direct messages only)
    if (recipient_id) {
      const blockCheck = await pool.query(
        `SELECT id FROM blocked_users
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)`,
        [uploaderId, recipient_id]
      );
      if (blockCheck.rows.length > 0) {
        return res.status(403).json({ error: 'Cannot send image to this user' });
      }

      // Recipient must exist
      const recipientCheck = await pool.query(
        `SELECT id FROM users WHERE id = $1`,
        [recipient_id]
      );
      if (recipientCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Recipient not found' });
      }
    }

    // Group membership check
    if (group_id) {
      const memberCheck = await pool.query(
        `SELECT id FROM group_members
         WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [group_id, uploaderId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this group' });
      }
    }

    // Store the encrypted blob. The server stores only opaque bytes —
    // no content inspection is performed here.
    const result = await pool.query(
      `INSERT INTO image_blobs
         (uploader_id, recipient_id, group_id,
          encrypted_blob, encryption_iv, sealed_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, uploader_id, recipient_id, group_id,
                 encryption_iv, sealed_key, created_at`,
      [
        uploaderId,
        recipient_id || null,
        group_id || null,
        encrypted_blob,
        encryption_iv,
        sealed_key
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Image upload error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/images/:id — Retrieve an encrypted blob ─────────
// Returns the encrypted blob + IV + sealed key so the recipient
// can decrypt client-side. Server never decrypts.
//
// Access control:
//   - DM:    uploader or recipient only
//   - Group: any active group member
router.get('/:id', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, uploader_id, recipient_id, group_id,
              encrypted_blob, encryption_iv, sealed_key, created_at
       FROM image_blobs WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = result.rows[0];

    // Enforce access control
    if (image.recipient_id) {
      if (image.uploader_id !== myId && image.recipient_id !== myId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } else if (image.group_id) {
      const memberCheck = await pool.query(
        `SELECT id FROM group_members
         WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [image.group_id, myId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.json(image);
  } catch (err) {
    console.error('Image fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/images/:id — Delete a blob ───────────────────
// Uploader can delete their own blobs.
// Called client-side after self-destruct or expiry confirmation.
// messages.js handles scheduling; this endpoint does the actual wipe.
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const myId = req.user.id;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, uploader_id FROM image_blobs WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    if (result.rows[0].uploader_id !== myId) {
      return res.status(403).json({ error: 'Only the uploader can delete this image' });
    }

    await pool.query(`DELETE FROM image_blobs WHERE id = $1`, [id]);

    return res.json({ message: 'Image deleted' });
  } catch (err) {
    console.error('Image delete error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
