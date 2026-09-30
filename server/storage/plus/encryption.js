import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'sbenc:v1:';

function keyFromSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encryptSecret(value, secret) {
  if (value === undefined || value === null) return '';
  if (!secret) throw new Error('Encryption secret is required');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFromSecret(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, encrypted].map(x => x.toString('base64url')).join('.');
}

export function decryptSecret(value, secret) {
  if (!value) return '';
  if (!secret) throw new Error('Encryption secret is required');
  if (!String(value).startsWith(PREFIX)) return String(value);
  const parts = String(value).slice(PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted secret');
  const [iv, tag, encrypted] = parts.map(x => Buffer.from(x, 'base64url'));
  const decipher = crypto.createDecipheriv(ALGORITHM, keyFromSecret(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
