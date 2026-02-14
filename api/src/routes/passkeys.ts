import { randomBytes, randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createPasskeyCredential,
  getPasskeyCredentialByCredentialId,
  listPasskeyCredentialsForUser,
  updatePasskeyCredentialUsage,
  createUser,
  upsertCustodialWallet,
  updateUser,
  getUserById,
  auditLog,
  findUserByHandle,
} from '../lib/db';
import { env } from '../config/env';
import { encryptSecret } from '../lib/vault';
import { Wallet } from 'ethers';
import { createSessionToken } from '../lib/auth';
import { getRedisClient, isRedisEnabled } from '../lib/redis';
import { isValidHandle, normalizeHandle } from '../lib/handles';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';

type PasskeyChallengeKind = 'register' | 'login';

type PasskeyChallengeRecord = {
  kind: PasskeyChallengeKind;
  challenge: string;
  createdAt: number;
  userHandle?: string;
  userIdHint?: string | null;
  allowedCredentialIds?: string[] | null;
  profile?: { handle?: string | null; email?: string | null; phone?: string | null } | null;
};

const PASSKEY_CHALLENGE_KEY_PREFIX = 'mmp:passkey:challenge:';
const inMemoryChallenges = new Map<string, PasskeyChallengeRecord>();

function challengeKey(challengeId: string) {
  return `${PASSKEY_CHALLENGE_KEY_PREFIX}${challengeId}`;
}

function isExpired(createdAt: number) {
  return Date.now() - createdAt > env.AUTH_CHALLENGE_TTL_MS;
}

async function persistPasskeyChallenge(challengeId: string, record: PasskeyChallengeRecord) {
  if (env.PERSISTENCE_STRICT_MODE && !isRedisEnabled()) {
    throw new Error('redis_required_for_passkey_challenges');
  }

  if (isRedisEnabled()) {
    const redis = getRedisClient();
    if (redis) {
      await redis.set(challengeKey(challengeId), JSON.stringify(record), 'PX', env.AUTH_CHALLENGE_TTL_MS);
      return;
    }
  }

  inMemoryChallenges.set(challengeId, record);
}

function safeParseChallenge(raw: string) {
  try {
    const parsed = JSON.parse(raw) as PasskeyChallengeRecord;
    if (!parsed?.challenge || typeof parsed.challenge !== 'string') return null;
    if (parsed.kind !== 'register' && parsed.kind !== 'login') return null;
    if (typeof parsed.createdAt !== 'number' || Number.isNaN(parsed.createdAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function consumePasskeyChallenge(challengeId: string) {
  if (isRedisEnabled()) {
    const redis = getRedisClient();
    if (redis) {
      const raw = await redis.get(challengeKey(challengeId));
      if (!raw) return null;
      await redis.del(challengeKey(challengeId));
      const parsed = safeParseChallenge(raw);
      if (!parsed || isExpired(parsed.createdAt)) {
        return null;
      }
      return parsed;
    }
  }

  const record = inMemoryChallenges.get(challengeId);
  if (!record) return null;
  inMemoryChallenges.delete(challengeId);
  if (isExpired(record.createdAt)) return null;
  return record;
}

function newUserHandle() {
  const bytes = randomBytes(32);
  return { bytes, value: isoBase64URL.fromBuffer(bytes) };
}

function normalizeWebAuthnId(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return isoBase64URL.fromBuffer(value);
  if (Buffer.isBuffer(value)) return isoBase64URL.fromBuffer(value);
  throw new Error('invalid_webauthn_id');
}

function normalizeWebAuthnPublicKey(value: unknown) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Buffer.isBuffer(value)) return Buffer.from(value).toString('base64');
  if (typeof value === 'string') {
    // Some adapters may already encode public keys.
    return value;
  }
  throw new Error('invalid_webauthn_public_key');
}

async function createUserWithCustodialWallet(profile?: { handle?: string | null; email?: string | null; phone?: string | null }) {
  const wallet = Wallet.createRandom();
  const user = await createUser(wallet.address.toLowerCase());
  await upsertCustodialWallet({
    userId: user.id,
    walletAddress: wallet.address.toLowerCase(),
    encryptedPrivateKeyJson: JSON.stringify(encryptSecret(wallet.privateKey)),
    keyVersion: 1,
  });

  if (profile?.handle || profile?.email || profile?.phone) {
    await updateUser({
      id: user.id,
      handle: profile.handle ?? undefined,
      email: profile.email ?? undefined,
      phone: profile.phone ?? undefined,
    });
  }

  return getUserById(user.id);
}

function sanitizeUser(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    walletAddress: user.wallet_address,
    handle: user.handle,
    email: user.email,
    emailMasked: user.email_mask ?? null,
    phone: user.phone,
    phoneMasked: user.phone_mask ?? null,
    balance: user.balance,
  };
}

export default async function (app: FastifyInstance) {
  app.post('/v1/auth/passkey/register/options', async (req, reply) => {
    const body = z
      .object({
        userName: z.string().min(1).max(120).optional(),
        displayName: z.string().min(1).max(120).optional(),
        handle: z.string().min(3).max(40).optional(),
        email: z.string().email().optional(),
        phone: z.string().min(6).optional(),
      })
      .parse(req.body);

    const requestedHandle = typeof body.handle === 'undefined' ? null : normalizeHandle(body.handle);
    if (requestedHandle && !isValidHandle(requestedHandle)) {
      reply.status(400).send({ error: 'invalid_handle' });
      return;
    }

    const challengeId = randomUUID();
    const userHandle = newUserHandle();
    const options = await generateRegistrationOptions({
      rpName: env.PASSKEY_RP_NAME,
      rpID: env.PASSKEY_RP_ID,
      userID: userHandle.bytes,
      userName: body.userName || requestedHandle || `mmp-${userHandle.value.slice(0, 8)}`,
      userDisplayName: body.displayName || body.userName || requestedHandle || 'MMP user',
      timeout: env.AUTH_CHALLENGE_TTL_MS,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      // Do not require attestation for consumer passkey onboarding.
      supportedAlgorithmIDs: [-7],
    });

    try {
      await persistPasskeyChallenge(challengeId, {
        kind: 'register',
        challenge: options.challenge,
        createdAt: Date.now(),
        userHandle: userHandle.value,
        userIdHint: null,
        allowedCredentialIds: null,
        profile: requestedHandle || body.email || body.phone
          ? { handle: requestedHandle, email: body.email ?? null, phone: body.phone ?? null }
          : null,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'redis_required_for_passkey_challenges') {
        reply.status(503).send({ error: 'redis_required', message: 'Redis is required for passkey challenges.' });
        return;
      }
      throw error;
    }

    reply.send({ challengeId, options });
  });

  app.post('/v1/auth/passkey/register/verify', async (req, reply) => {
    const body = z
      .object({
        challengeId: z.string().min(1),
        response: z.any(),
      })
      .parse(req.body) as { challengeId: string; response: any };

    const record = await consumePasskeyChallenge(body.challengeId);
    if (!record || record.kind !== 'register' || !record.userHandle) {
      reply.status(400).send({ error: 'invalid_or_expired_challenge' });
      return;
    }

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: record.challenge,
        expectedOrigin: env.PASSKEY_ORIGIN,
        expectedRPID: env.PASSKEY_RP_ID,
      });
    } catch {
      reply.status(401).send({ error: 'passkey_registration_failed' });
      return;
    }

    if (!verification.verified || !verification.registrationInfo) {
      reply.status(401).send({ error: 'passkey_registration_failed' });
      return;
    }

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo as any;
    let credentialId: string;
    let publicKeyB64: string;
    try {
      credentialId = normalizeWebAuthnId(credentialID);
      publicKeyB64 = normalizeWebAuthnPublicKey(credentialPublicKey);
    } catch {
      reply.status(401).send({ error: 'passkey_registration_failed' });
      return;
    }

    const profile = record.profile || undefined;

    const user = await createUserWithCustodialWallet(profile);
    if (!user) {
      reply.status(500).send({ error: 'user_create_failed' });
      return;
    }

    try {
      await createPasskeyCredential({
        userId: user.id,
        userHandle: record.userHandle,
        rpId: env.PASSKEY_RP_ID,
        credentialId,
        publicKeyB64,
        counter: Number(counter || 0),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'passkey_credential_collision') {
        reply.status(409).send({ error: 'passkey_credential_collision' });
        return;
      }
      throw error;
    }

    const token = createSessionToken({ userId: user.id });
    await auditLog(user.id, 'passkey_registered', {
      credentialId,
      rpId: env.PASSKEY_RP_ID,
    });

    reply.send({ ok: true, user: sanitizeUser(user), token });
  });

  app.post('/v1/auth/passkey/login/options', async (req, reply) => {
    const body = z
      .object({
        userId: z.string().min(1).optional(),
        handle: z.string().min(3).max(40).optional(),
      })
      .parse(req.body);

    let allowCredentials: Array<{ id: string }> | undefined = undefined;
    let allowCredentialIds: string[] | null = null;
    if (body.userId || body.handle) {
      let userId = body.userId;
      if (!userId && body.handle) {
        // Avoid pulling in full resolver logic; passkey login supports direct handle targeting.
        const normalized = normalizeHandle(body.handle);
        if (!isValidHandle(normalized)) {
          reply.status(400).send({ error: 'invalid_handle' });
          return;
        }
        const user = await findUserByHandle(normalized, false);
        userId = user?.id;
      }

      if (!userId) {
        reply.status(404).send({ error: 'user_not_found' });
        return;
      }
      const creds = await listPasskeyCredentialsForUser(userId);
      allowCredentialIds = creds.map((cred) => cred.credentialId);
      allowCredentials = creds.map((cred) => ({ id: cred.credentialId }));
    }

    const challengeId = randomUUID();
    const options = await generateAuthenticationOptions({
      rpID: env.PASSKEY_RP_ID,
      timeout: env.AUTH_CHALLENGE_TTL_MS,
      allowCredentials,
      userVerification: 'preferred',
    });

    try {
      await persistPasskeyChallenge(challengeId, {
        kind: 'login',
        challenge: options.challenge,
        createdAt: Date.now(),
        allowedCredentialIds: allowCredentialIds,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'redis_required_for_passkey_challenges') {
        reply.status(503).send({ error: 'redis_required', message: 'Redis is required for passkey challenges.' });
        return;
      }
      throw error;
    }

    reply.send({ challengeId, options });
  });

  app.post('/v1/auth/passkey/login/verify', async (req, reply) => {
    const body = z
      .object({
        challengeId: z.string().min(1),
        response: z.any(),
      })
      .parse(req.body) as { challengeId: string; response: any };

    const record = await consumePasskeyChallenge(body.challengeId);
    if (!record || record.kind !== 'login') {
      reply.status(400).send({ error: 'invalid_or_expired_challenge' });
      return;
    }

    const credentialId = body.response?.id;
    if (!credentialId || typeof credentialId !== 'string') {
      reply.status(400).send({ error: 'missing_credential_id' });
      return;
    }

    if (record.allowedCredentialIds?.length && !record.allowedCredentialIds.includes(credentialId)) {
      reply.status(401).send({ error: 'credential_not_allowed' });
      return;
    }

    const credential = await getPasskeyCredentialByCredentialId(credentialId);
    if (!credential) {
      reply.status(401).send({ error: 'unknown_credential' });
      return;
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: record.challenge,
        expectedOrigin: env.PASSKEY_ORIGIN,
        expectedRPID: env.PASSKEY_RP_ID,
        authenticator: {
          credentialID: credential.credentialId,
          credentialPublicKey: Buffer.from(credential.publicKeyB64, 'base64'),
          counter: credential.counter,
        },
      });
    } catch {
      reply.status(401).send({ error: 'passkey_auth_failed' });
      return;
    }

    if (!verification.verified) {
      reply.status(401).send({ error: 'passkey_auth_failed' });
      return;
    }

    const newCounter = verification.authenticationInfo?.newCounter;
    if (typeof newCounter === 'number') {
      await updatePasskeyCredentialUsage({ credentialId: credential.credentialId, counter: newCounter });
    }

    const user = await getUserById(credential.userId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }

    const token = createSessionToken({ userId: user.id });
    await auditLog(user.id, 'passkey_authenticated', { credentialId: credential.credentialId });
    reply.send({ ok: true, user: sanitizeUser(user), token });
  });
}
