import { createHmac } from 'node:crypto';
import { env } from '../config/env';

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string) {
  let value = phone.trim();
  value = value.replace(/[^\d+]/g, '');
  if (value.startsWith('00')) {
    value = `+${value.slice(2)}`;
  }
  if (!value.startsWith('+')) {
    value = `+${value}`;
  }
  return value;
}

export function maskEmail(email: string) {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf('@');
  if (at === -1) {
    return '***';
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const first = local.slice(0, 1);
  return `${first || '*'}***@${domain || '***'}`;
}

export function maskPhone(phone: string) {
  const digits = normalizePhone(phone).replace(/\D/g, '');
  const last4 = digits.slice(-4);
  if (!last4) return '***';
  return `***${last4}`;
}

export function hmacPii(value: string, purpose: string) {
  const secret = String(env.PII_HASH_KEY || env.SESSION_SECRET);
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');
}

