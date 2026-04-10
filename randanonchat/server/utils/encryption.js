const sodium = require('libsodium-wrappers');

let ready = false;

async function ensureReady() {
  if (!ready) {
    await sodium.ready;
    ready = true;
  }
}

// ── Key pair generation ─────────────────────────────────────
// Used server-side only for verification or admin tooling.
// Normal signup key pairs are generated CLIENT-SIDE.

async function generateKeyPair() {
  await ensureReady();
  const keyPair = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(keyPair.publicKey),
    privateKey: sodium.to_base64(keyPair.privateKey)
  };
}

// ── Validate a public key ───────────────────────────────────
// Checks that a base64-encoded public key is the correct length
// for X25519 (32 bytes). Called during signup to reject bad keys.

async function validatePublicKey(publicKeyB64) {
  await ensureReady();
  try {
    const keyBytes = sodium.from_base64(publicKeyB64);
    return keyBytes.length === sodium.crypto_box_PUBLICKEYBYTES;
  } catch {
    return false;
  }
}

// ── Sealed box encryption (crypto_box_seal) ─────────────────
// Encrypt data so only the holder of the corresponding private key
// can decrypt. Used server-side for sealing symmetric keys to
// group members' public keys.

async function sealForRecipient(data, recipientPublicKeyB64) {
  await ensureReady();
  const recipientPublicKey = sodium.from_base64(recipientPublicKeyB64);
  const dataBytes = typeof data === 'string' ? sodium.from_string(data) : new Uint8Array(data);
  const sealed = sodium.crypto_box_seal(dataBytes, recipientPublicKey);
  return sodium.to_base64(sealed);
}

// ── Seal a symmetric key to multiple recipients ─────────────
// For group image encryption: same symmetric key sealed individually
// to each member's public key.

async function sealKeyForGroup(symmetricKeyB64, memberPublicKeysB64) {
  await ensureReady();
  const symmetricKey = sodium.from_base64(symmetricKeyB64);
  const sealedKeys = memberPublicKeysB64.map((pubKeyB64) => {
    const publicKey = sodium.from_base64(pubKeyB64);
    return sodium.to_base64(sodium.crypto_box_seal(symmetricKey, publicKey));
  });
  return sealedKeys;
}

// ── Generate a random symmetric key ─────────────────────────
// For hybrid image encryption: random key encrypts the blob,
// then the key itself is sealed to each recipient.

async function generateSymmetricKey() {
  await ensureReady();
  const key = sodium.crypto_secretbox_keygen();
  return sodium.to_base64(key);
}

// ── Generate a random nonce ─────────────────────────────────

async function generateNonce() {
  await ensureReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  return sodium.to_base64(nonce);
}

module.exports = {
  ensureReady,
  generateKeyPair,
  validatePublicKey,
  sealForRecipient,
  sealKeyForGroup,
  generateSymmetricKey,
  generateNonce
};
