import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { env } from '../config/env';

function keyFromMaster() {
  return createHash('sha256').update(String(env.VAULT_MASTER_KEY)).digest();
}

export function encryptSecret(raw: string) {
  const key = keyFromMaster();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(payload: { ciphertext: string; iv: string; tag: string }) {
  const key = keyFromMaster();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return plaintext;
}

export function secretKeyRef(channel: string, userId: string) {
  return `${channel}-${userId}-${Date.now()}`;
}
