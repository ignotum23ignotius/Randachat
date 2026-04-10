import sodium from 'libsodium-wrappers';

let ready = false;

async function ensureReady() {
  if (!ready) {
    await sodium.ready;
    ready = true;
  }
}

// ── Key pair generation (called once at signup) ─────────────
// Private key stays in localStorage — NEVER leaves the device.
// Public key is sent to the server and stored in the database.

export async function generateKeyPair() {
  await ensureReady();
  const keyPair = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(keyPair.publicKey),
    privateKey: sodium.to_base64(keyPair.privateKey)
  };
}

export function savePrivateKey(privateKey) {
  localStorage.setItem('privateKey', privateKey);
}

export function getPrivateKey() {
  return localStorage.getItem('privateKey');
}

export function clearPrivateKey() {
  localStorage.removeItem('privateKey');
}

// ── Message encryption (crypto_box) ─────────────────────────
// X25519-XSalsa20-Poly1305: sender's private key + recipient's public key

export async function encryptMessage(plaintext, recipientPublicKeyB64, senderPrivateKeyB64) {
  await ensureReady();

  const recipientPublicKey = sodium.from_base64(recipientPublicKeyB64);
  const senderPrivateKey = sodium.from_base64(senderPrivateKeyB64);
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const messageBytes = sodium.from_string(plaintext);

  const encrypted = sodium.crypto_box_easy(messageBytes, nonce, recipientPublicKey, senderPrivateKey);

  return {
    encrypted_content: sodium.to_base64(encrypted),
    encryption_iv: sodium.to_base64(nonce)
  };
}

export async function decryptMessage(encryptedContentB64, nonceB64, senderPublicKeyB64, recipientPrivateKeyB64) {
  await ensureReady();

  const encrypted = sodium.from_base64(encryptedContentB64);
  const nonce = sodium.from_base64(nonceB64);
  const senderPublicKey = sodium.from_base64(senderPublicKeyB64);
  const recipientPrivateKey = sodium.from_base64(recipientPrivateKeyB64);

  const decrypted = sodium.crypto_box_open_easy(encrypted, nonce, senderPublicKey, recipientPrivateKey);

  return sodium.to_string(decrypted);
}

// ── Image hybrid encryption (crypto_secretbox + crypto_box_seal) ──
// 1. Generate random symmetric key
// 2. Encrypt image blob with crypto_secretbox (symmetric)
// 3. Seal the symmetric key to the recipient's public key via crypto_box_seal
// For groups: same encrypted blob, key sealed to each member's public key

export async function encryptImage(imageBuffer, recipientPublicKeyB64) {
  await ensureReady();

  const recipientPublicKey = sodium.from_base64(recipientPublicKeyB64);

  // Random symmetric key for the image blob
  const symmetricKey = sodium.crypto_secretbox_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

  // Encrypt image blob with symmetric key
  const imageBytes = new Uint8Array(imageBuffer);
  const encryptedBlob = sodium.crypto_secretbox_easy(imageBytes, nonce, symmetricKey);

  // Seal the symmetric key to the recipient's public key
  const sealedKey = sodium.crypto_box_seal(symmetricKey, recipientPublicKey);

  return {
    encrypted_blob: sodium.to_base64(encryptedBlob),
    encryption_iv: sodium.to_base64(nonce),
    sealed_key: sodium.to_base64(sealedKey)
  };
}

export async function encryptImageForGroup(imageBuffer, memberPublicKeysB64) {
  await ensureReady();

  // Random symmetric key — shared across all members
  const symmetricKey = sodium.crypto_secretbox_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

  // Encrypt image blob once with symmetric key
  const imageBytes = new Uint8Array(imageBuffer);
  const encryptedBlob = sodium.crypto_secretbox_easy(imageBytes, nonce, symmetricKey);

  // Seal the symmetric key to each member's public key
  const sealedKeys = memberPublicKeysB64.map((pubKeyB64) => {
    const publicKey = sodium.from_base64(pubKeyB64);
    return sodium.to_base64(sodium.crypto_box_seal(symmetricKey, publicKey));
  });

  return {
    encrypted_blob: sodium.to_base64(encryptedBlob),
    encryption_iv: sodium.to_base64(nonce),
    sealed_keys: sealedKeys
  };
}

export async function decryptImage(encryptedBlobB64, nonceB64, sealedKeyB64, recipientPublicKeyB64, recipientPrivateKeyB64) {
  await ensureReady();

  const encryptedBlob = sodium.from_base64(encryptedBlobB64);
  const nonce = sodium.from_base64(nonceB64);
  const sealedKey = sodium.from_base64(sealedKeyB64);
  const recipientPublicKey = sodium.from_base64(recipientPublicKeyB64);
  const recipientPrivateKey = sodium.from_base64(recipientPrivateKeyB64);

  // Unseal the symmetric key
  const symmetricKey = sodium.crypto_box_seal_open(sealedKey, recipientPublicKey, recipientPrivateKey);

  // Decrypt the image blob
  const decryptedBlob = sodium.crypto_secretbox_open_easy(encryptedBlob, nonce, symmetricKey);

  return decryptedBlob.buffer;
}
