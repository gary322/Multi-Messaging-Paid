import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditLog, createUser, findUserByHandle, findUserByWallet, saveIdentityBinding, updateUser } from '../lib/db';
import { createSessionToken, getAuthUserId } from '../lib/auth';
import { env } from '../config/env';
import { isValidHandle, normalizeHandle } from '../lib/handles';
import {
  isAllowedProvider,
  isConfiguredForMethod,
  makeAuthChallenge,
  resolveIdentityWallet,
  type IdentityMethod,
} from '../lib/identity';
import { getSupportedIdentityProviders } from '../lib/identity';
import { getRedisClient, isRedisEnabled } from '../lib/redis';
import { requireLaunchReady } from '../lib/complianceGuard';

type ChallengeRecord = {
  challenge: string;
  method: IdentityMethod;
  provider?: string;
  subjectHint?: string;
  createdAt: number;
};

const challenges = new Map<string, ChallengeRecord>();
const AUTH_CHALLENGE_KEY_PREFIX = 'mmp:auth:challenge:';

function challengeRedisKey(challengeId: string) {
  return `${AUTH_CHALLENGE_KEY_PREFIX}${challengeId}`;
}

function createChallengeId() {
  return randomUUID();
}

function safeParseChallenge(raw: string): ChallengeRecord | null {
  try {
    const parsed = JSON.parse(raw) as ChallengeRecord;
    if (!parsed?.challenge || typeof parsed.challenge !== 'string') {
      return null;
    }
    if (!['wallet', 'passkey', 'social'].includes(parsed.method || '')) {
      return null;
    }
    if (typeof parsed.createdAt !== 'number' || Number.isNaN(parsed.createdAt)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isExpired(createdAt: number) {
  return Date.now() - createdAt > env.AUTH_CHALLENGE_TTL_MS;
}

async function persistChallenge(
  challengeId: string,
  challenge: string,
  method: IdentityMethod,
  provider?: string,
  subjectHint?: string,
) {
  const payload: ChallengeRecord = {
    challenge,
    method,
    provider,
    subjectHint,
    createdAt: Date.now(),
  };

  if (env.PERSISTENCE_STRICT_MODE && !isRedisEnabled()) {
    throw new Error('redis_required_for_auth_challenges');
  }

  if (isRedisEnabled()) {
    const redis = getRedisClient();
    if (redis) {
      await redis.set(challengeRedisKey(challengeId), JSON.stringify(payload), 'PX', env.AUTH_CHALLENGE_TTL_MS);
      return;
    }
  }

  challenges.set(challengeId, payload);
}

async function consumeChallenge(challengeId: string) {
  if (isRedisEnabled()) {
    const redis = getRedisClient();
    if (redis) {
      const raw = await redis.get(challengeRedisKey(challengeId));
      if (!raw) return null;
      await redis.del(challengeRedisKey(challengeId));
      const parsed = safeParseChallenge(raw);
      if (!parsed || isExpired(parsed.createdAt)) {
        return null;
      }
      return parsed;
    }
  }

  const row = challenges.get(challengeId);
  if (!row) {
    return null;
  }
  challenges.delete(challengeId);

  if (isExpired(row.createdAt)) {
    return null;
  }
  return row;
}

function sanitize(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    walletAddress: user.wallet_address,
    email: user.email,
    emailMasked: user.email_mask ?? null,
    phone: user.phone,
    phoneMasked: user.phone_mask ?? null,
    handle: user.handle,
    basename: user.basename ?? null,
    balance: user.balance,
    discoverableByHandle: user.discoverable_by_handle,
    discoverableByPhone: user.discoverable_by_phone,
  };
}

async function findOrCreateUserForWallet(walletAddress: string, handleHint?: string) {
  const normalized = walletAddress.toLowerCase();
  const existing = await findUserByWallet(normalized);
  if (existing) return existing;

  const user = await createUser(normalized);
  if (handleHint) {
    const safeHandle = handleHint.slice(0, 40).replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (safeHandle && isValidHandle(safeHandle)) {
      await updateUser({ id: (user as any).id, handle: safeHandle });
    }
  }
  return findUserByWallet(normalized);
}

export default async function (app: FastifyInstance) {
  app.get('/v1/auth/providers', async () => {
    return {
      providers: getSupportedIdentityProviders(),
      providersByMethod: {
        wallet: getSupportedIdentityProviders('wallet'),
        social: getSupportedIdentityProviders('social'),
        passkey: getSupportedIdentityProviders('passkey'),
      },
      identityVerificationStrict: env.IDENTITY_VERIFICATION_STRICT,
      socialVerifyUrl: env.SOCIAL_VERIFY_URL || null,
      passkeyVerifyUrl: env.PASSKEY_VERIFY_URL || null,
      allowedProviders: env.IDENTITY_ALLOWED_PROVIDERS,
    };
  });

  app.post('/v1/auth/register', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z
      .object({
        walletAddress: z.string().min(20),
        email: z.string().email().optional(),
        phone: z.string().min(6).optional(),
        handle: z.string().min(3).max(40).optional(),
      })
      .parse(req.body);

    const normalizedWallet = body.walletAddress.toLowerCase();
    const requestedHandle =
      typeof body.handle === 'undefined' ? undefined : normalizeHandle(body.handle);
    if (requestedHandle && !isValidHandle(requestedHandle)) {
      reply.status(400).send({ error: 'invalid_handle' });
      return;
    }

    const existing = await findUserByWallet(normalizedWallet);
    if (existing) {
      const user = existing as any;
      const currentHandle = user.handle ? String(user.handle).toLowerCase() : null;
      if (requestedHandle && currentHandle && requestedHandle !== currentHandle) {
        reply.status(409).send({
          error: 'handle_change_requires_profile',
          message: 'Handle changes must be performed via /v1/profile to enforce rotation rules.',
        });
        return;
      }
      if (requestedHandle) {
        const byHandle = await findUserByHandle(requestedHandle);
        if (byHandle && byHandle.id !== user.id) {
          reply.status(409).send({ error: 'handle_conflict' });
          return;
        }
      }
      const updated = await updateUser({
        id: user.id,
        email: body.email,
        phone: body.phone,
        handle: requestedHandle,
      });
      const token = createSessionToken({ userId: user.id });
      return reply.send({ user: sanitize(updated), token });
    }

    if (requestedHandle) {
      const byHandle = await findUserByHandle(requestedHandle);
      if (byHandle) {
        reply.status(409).send({ error: 'handle_conflict' });
        return;
      }
    }

    const user = await createUser(normalizedWallet);
    const updated = await updateUser({
      id: (user as any).id,
      email: body.email,
      phone: body.phone,
      handle: requestedHandle,
    });
    const token = createSessionToken({ userId: user.id });
    return reply.send({ user: sanitize(updated), token });
  });

  app.post('/v1/auth/challenge', async (req, reply) => {
    const body = z
      .object({
        method: z.enum(['wallet', 'passkey', 'social']),
        provider: z.string().optional(),
        subjectHint: z.string().optional(),
      })
      .parse(req.body);

    if ((body.method === 'social' || body.method === 'passkey') && !body.provider) {
      reply.status(400).send({
        error: 'provider_required',
        message: 'provider is required for social and passkey challenges.',
      });
      return;
    }

    if ((body.method === 'social' || body.method === 'passkey')) {
      const provider = body.provider?.toLowerCase() || 'wallet';
      if (!isAllowedProvider(body.method, provider)) {
        reply.status(403).send({
          error: 'provider_not_allowed',
          message: 'Provider is not permitted by platform policy.',
        });
        return;
      }
      if (!isConfiguredForMethod(body.method, provider)) {
        reply.status(503).send({
          error: 'identity_verifier_unavailable',
          message: 'Identity verifier is not configured for this method yet.',
        });
        return;
      }
    }

    const challenge = await makeAuthChallenge(body.method, body.provider, body.subjectHint);
    const challengeId = createChallengeId();
    try {
      await persistChallenge(challengeId, challenge, body.method, body.provider, body.subjectHint);
    } catch (error) {
      if (error instanceof Error && error.message === 'redis_required_for_auth_challenges') {
        reply.status(503).send({
          error: 'redis_required',
          message: 'Redis is required to persist auth challenges in strict persistence mode.',
        });
        return;
      }
      throw error;
    }

    return reply.send({ challengeId, challenge, expiresInMs: env.AUTH_CHALLENGE_TTL_MS });
  });

  app.post('/v1/auth/verify', async (req, reply) => {
    const body = z
      .object({
        challengeId: z.string().min(1),
        method: z.enum(['wallet', 'passkey', 'social']),
        provider: z.string().optional(),
        subject: z.string().optional(),
        walletAddress: z.string().optional(),
        proof: z.string().min(1).optional(),
        signature: z.string().optional(),
        termsVersion: z.string().optional(),
        termsAcceptedAt: z.number().optional(),
      })
      .parse(req.body);

    const proof = body.proof || body.signature;
    if (!proof) {
      reply.status(400).send({ error: 'missing_proof' });
      return;
    }

    const record = await consumeChallenge(body.challengeId);
    if (!record) {
      reply.status(400).send({ error: 'invalid_or_expired_challenge' });
      return;
    }

    if (record.method !== body.method) {
      reply.status(400).send({ error: 'challenge_method_mismatch' });
      return;
    }

    if ((body.method === 'social' || body.method === 'passkey') && !body.subject) {
      reply.status(400).send({ error: 'missing_subject' });
      return;
    }

    const provider = body.provider || record.provider;
    if ((body.method === 'social' || body.method === 'passkey') && provider && record.provider && provider !== record.provider) {
      reply.status(400).send({ error: 'challenge_provider_mismatch' });
      return;
    }

    if ((body.method === 'social' || body.method === 'passkey') && !provider) {
      reply.status(400).send({ error: 'provider_required' });
      return;
    }

    if ((body.method === 'social' || body.method === 'passkey') && env.REQUIRE_SOCIAL_TOS_ACCEPTED) {
      if (!body.termsVersion) {
        reply.status(403).send({
          error: 'compliance_required',
          message: 'Terms acceptance/version required before social/passkey auth.',
        });
        return;
      }
      const requestedTermsVersion = body.termsVersion;
      if (requestedTermsVersion !== env.LEGAL_TOS_VERSION) {
        reply.status(403).send({
          error: 'compliance_required',
          message: 'Terms acceptance/version required before social/passkey auth.',
        });
        return;
      }
      if (!body.termsAcceptedAt || body.termsAcceptedAt <= 0) {
        reply.status(403).send({
          error: 'compliance_required',
          message: 'Terms acceptance timestamp is required when REQUIRE_SOCIAL_TOS_ACCEPTED is enabled.',
        });
        return;
      }
    }

    const resolved = await resolveIdentityWallet({
      method: body.method,
      challenge: record.challenge,
      proof,
      provider,
      subject: body.subject,
      expectedWalletAddress: body.walletAddress,
    });

    if (!resolved) {
      reply.status(401).send({ error: 'identity_verification_failed' });
      return;
    }

    const user = await findOrCreateUserForWallet(
      resolved.walletAddress,
      resolved.provider || provider || body.subject,
    );

    if (!user) {
      reply.status(500).send({ error: 'user_create_failed' });
      return;
    }

    const token = createSessionToken({ userId: user.id });
    try {
      await saveIdentityBinding({
        walletAddress: resolved.walletAddress,
        method: body.method,
        provider: resolved.provider,
        subject: resolved.subject,
        userId: user.id,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'identity_wallet_collision') {
        reply.status(409).send({ error: 'identity_wallet_collision' });
        return;
      }
      throw error;
    }

    await auditLog(user.id, 'auth_verified', {
      method: body.method,
      provider: resolved.provider,
      subject: resolved.subject,
      challengeId: body.challengeId,
      subjectHint: record.subjectHint || null,
      termsAccepted: Boolean(body.termsAcceptedAt),
      termsVersion: body.termsVersion || null,
      termsAcceptedAt: body.termsAcceptedAt || null,
    });

    reply.send({
      walletAddress: user.wallet_address,
      user: sanitize(user),
      token,
      method: body.method,
    });
  });

  app.post('/v1/auth/issue-session', async (req, reply) => {
    const body = z.object({ walletAddress: z.string().min(20) }).parse(req.body);
    const user = await findUserByWallet(body.walletAddress.toLowerCase());
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }
    const token = createSessionToken({ userId: user.id });
    return reply.send({ token, userId: user.id });
  });

  app.get('/v1/auth/whoami', async (req, reply) => {
    const userId = getAuthUserId(req);
    if (!userId) {
      reply.status(401).send({ error: 'auth_required' });
      return;
    }
    reply.send({ userId });
  });
}
