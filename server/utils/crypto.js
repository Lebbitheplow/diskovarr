const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;

function deriveKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required for encryption');
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext) {
  const key = deriveKey();
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

function decrypt(cipherText) {
  const key = deriveKey();
  const buf = Buffer.from(cipherText, 'base64');
  // Layout: [salt | iv | tag | ciphertext]. Salt is skipped — deriveKey() is salt-agnostic.
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + 16);
  const encrypted = buf.subarray(SALT_LEN + IV_LEN + 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
