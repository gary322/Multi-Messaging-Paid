import { createHmac, randomUUID } from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';

export type SessionClaims = {
  userId: string;
};

export function createSessionToken(claims: SessionClaims): string {
  const payload = JSON.stringify({
    ...claims,
    iss: 'mmp-api',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor((Date.now() + env.SESSION_TTL_MS) / 1000),
    v: 1,
  });
  const sig = signPayload(payload);
  return `mmp.${toBase64(payload)}.${sig}`;
}

export function verifySessionToken(token: string): SessionClaims | null {
  if (!token || !token.startsWith('mmp.')) return null;
  const [, rawPayload, signature] = token.split('.');
  if (!rawPayload || !signature) return null;
  const payload = fromBase64(rawPayload);
  if (!payload) return null;
  const expectedSig = signPayload(payload);
  if (signature !== expectedSig) return null;

  let claims: Record<string, any>;
  try {
    claims = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof claims.userId !== 'string' || !claims.userId) return null;
  if (typeof claims.exp !== 'number' || Number.isNaN(claims.exp)) return null;
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  return { userId: claims.userId };
}

export function getAuthUserId(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : header.trim();
  if (!token) return null;
  const session = verifySessionToken(token);
  return session?.userId ?? null;
}

export function requireAuthUser(req: FastifyRequest, reply: FastifyReply, explicitUserId?: string): string | null {
  const authedUserId = getAuthUserId(req);
  if (!authedUserId) {
    reply.status(401).send({ error: 'auth_required' });
    return null;
  }
  if (explicitUserId && explicitUserId !== authedUserId) {
    reply.status(403).send({ error: 'auth_mismatch' });
    return null;
  }
  return authedUserId;
}

export function createSessionChallenge() {
  return randomUUID();
}

function signPayload(payload: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(payload).digest('base64url');
}

function toBase64(raw: string): string {
  return Buffer.from(raw).toString('base64url');
}

function fromBase64(encoded: string): string | null {
  try {
    return Buffer.from(encoded, 'base64url').toString();
  } catch {
    return null;
  }
}
