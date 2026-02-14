import { randomBytes, randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  auditLog,
  createUser,
  findUserByHandle,
  getIdentityBinding,
  getUserById,
  saveIdentityBinding,
  updateUser,
  upsertCustodialWallet,
} from '../lib/db';
import { env } from '../config/env';
import { createSessionToken } from '../lib/auth';
import { encryptSecret } from '../lib/vault';
import { Wallet } from 'ethers';
import { getRedisClient, isRedisEnabled } from '../lib/redis';
import { isValidHandle, normalizeHandle } from '../lib/handles';
import {
  getSocialOAuthProviderConfig,
  getSocialOAuthProviderReadiness,
  type SocialOAuthProvider,
} from '../services/socialOAuth';

type OAuthStateRecord = {
  provider: SocialOAuthProvider;
  codeVerifier: string;
  createdAt: number;
};

const STATE_KEY_PREFIX = 'mmp:social:oauth:state:';
const inMemoryStates = new Map<string, OAuthStateRecord>();

function stateKey(stateId: string) {
  return `${STATE_KEY_PREFIX}${stateId}`;
}

function isExpired(createdAt: number) {
  return Date.now() - createdAt > env.SOCIAL_OAUTH_STATE_TTL_MS;
}

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url');
}

function sha256Base64url(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

function safeParseState(raw: string): OAuthStateRecord | null {
  try {
    const parsed = JSON.parse(raw) as OAuthStateRecord;
    if (!parsed?.provider || (parsed.provider !== 'google' && parsed.provider !== 'github')) return null;
    if (!parsed?.codeVerifier || typeof parsed.codeVerifier !== 'string') return null;
    if (typeof parsed.createdAt !== 'number' || Number.isNaN(parsed.createdAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function persistState(stateId: string, record: OAuthStateRecord) {
  if (env.PERSISTENCE_STRICT_MODE && !isRedisEnabled()) {
    throw new Error('redis_required_for_social_oauth_state');
  }

  if (isRedisEnabled()) {
    const redis = getRedisClient();
    if (redis) {
      await redis.set(stateKey(stateId), JSON.stringify(record), 'PX', env.SOCIAL_OAUTH_STATE_TTL_MS);
      return;
    }
  }

  inMemoryStates.set(stateId, record);
}

async function consumeState(stateId: string): Promise<OAuthStateRecord | null> {
  if (isRedisEnabled()) {
    const redis = getRedisClient();
    if (redis) {
      const raw = await redis.get(stateKey(stateId));
      if (!raw) return null;
      await redis.del(stateKey(stateId));
      const parsed = safeParseState(raw);
      if (!parsed || isExpired(parsed.createdAt)) return null;
      return parsed;
    }
  }

  const record = inMemoryStates.get(stateId);
  if (!record) return null;
  inMemoryStates.delete(stateId);
  if (isExpired(record.createdAt)) return null;
  return record;
}

async function exchangeCodeForAccessToken(config: ReturnType<typeof getSocialOAuthProviderConfig>, code: string, codeVerifier: string) {
  if (!config) return null;

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('client_id', config.clientId);
  body.set('client_secret', config.clientSecret);
  body.set('redirect_uri', config.redirectUri);
  body.set('code_verifier', codeVerifier);

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(Math.min(10_000, env.NOTIFICATION_PROVIDER_TIMEOUT_MS)),
  });

  const json = (await response.json().catch(() => null)) as any;
  if (!response.ok || !json) {
    return null;
  }
  if (typeof json.access_token !== 'string' || !json.access_token) {
    return null;
  }
  return json.access_token as string;
}

async function fetchUserInfo(config: ReturnType<typeof getSocialOAuthProviderConfig>, accessToken: string) {
  if (!config) return null;

  const response = await fetch(config.userInfoUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      // Some providers (e.g. GitHub) require a UA.
      'user-agent': 'mmp-api',
    },
    signal: AbortSignal.timeout(Math.min(10_000, env.NOTIFICATION_PROVIDER_TIMEOUT_MS)),
  });

  const json = (await response.json().catch(() => null)) as any;
  if (!response.ok || !json) {
    return null;
  }
  return json;
}

function profileFromUserInfo(provider: SocialOAuthProvider, info: any) {
  if (provider === 'google') {
    const subject = typeof info.sub === 'string' ? info.sub : '';
    const email = typeof info.email === 'string' ? info.email : null;
    const emailVerified = Boolean(info.email_verified);
    return { subject, email, emailVerified, handleHint: null as string | null };
  }
  if (provider === 'github') {
    const subject = typeof info.id === 'number' || typeof info.id === 'string' ? String(info.id) : '';
    const handleHint = typeof info.login === 'string' ? info.login : null;
    return { subject, email: null as string | null, emailVerified: false, handleHint };
  }
  return { subject: '', email: null as string | null, emailVerified: false, handleHint: null as string | null };
}

async function createUserWithCustodialWallet() {
  const wallet = Wallet.createRandom();
  const user = await createUser(wallet.address.toLowerCase());
  await upsertCustodialWallet({
    userId: user.id,
    walletAddress: wallet.address.toLowerCase(),
    encryptedPrivateKeyJson: JSON.stringify(encryptSecret(wallet.privateKey)),
    keyVersion: 1,
  });
  return { userId: user.id, walletAddress: wallet.address.toLowerCase() };
}

function safeHandleFromHint(hint: string) {
  const candidate = hint.slice(0, 40).replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const normalized = normalizeHandle(candidate);
  if (!normalized || !isValidHandle(normalized)) {
    return null;
  }
  return normalized;
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
  app.get('/v1/auth/social/providers', async () => {
    return {
      providers: getSocialOAuthProviderReadiness(),
    };
  });

  app.post('/v1/auth/social/:provider/start', async (req, reply) => {
    const params = z.object({ provider: z.enum(['google', 'github']) }).parse(req.params);
    const provider = params.provider as SocialOAuthProvider;
    const config = getSocialOAuthProviderConfig(provider);
    if (!config) {
      reply.status(503).send({ error: 'oauth_provider_not_configured', provider });
      return;
    }

    const stateId = randomUUID();
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = sha256Base64url(codeVerifier);

    const authUrl = new URL(config.authorizationUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('scope', config.scope);
    authUrl.searchParams.set('state', stateId);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    try {
      await persistState(stateId, {
        provider,
        codeVerifier,
        createdAt: Date.now(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'redis_required_for_social_oauth_state') {
        reply.status(503).send({
          error: 'redis_required',
          message: 'Redis is required to persist OAuth state in strict persistence mode.',
        });
        return;
      }
      throw error;
    }

    reply.send({
      provider,
      state: stateId,
      authorizationUrl: authUrl.toString(),
      expiresInMs: env.SOCIAL_OAUTH_STATE_TTL_MS,
    });
  });

  app.post('/v1/auth/social/:provider/exchange', async (req, reply) => {
    const params = z.object({ provider: z.enum(['google', 'github']) }).parse(req.params);
    const provider = params.provider as SocialOAuthProvider;
    const body = z
      .object({
        state: z.string().min(1),
        code: z.string().min(1),
        termsVersion: z.string().optional(),
        termsAcceptedAt: z.number().optional(),
      })
      .parse(req.body);

    if (env.REQUIRE_SOCIAL_TOS_ACCEPTED) {
      if (!body.termsVersion || body.termsVersion !== env.LEGAL_TOS_VERSION) {
        reply.status(403).send({ error: 'compliance_required', message: 'termsVersion must match LEGAL_TOS_VERSION.' });
        return;
      }
      if (!body.termsAcceptedAt || body.termsAcceptedAt <= 0) {
        reply.status(403).send({ error: 'compliance_required', message: 'termsAcceptedAt is required.' });
        return;
      }
    }

    const state = await consumeState(body.state);
    if (!state || state.provider !== provider) {
      reply.status(400).send({ error: 'invalid_or_expired_state' });
      return;
    }

    const config = getSocialOAuthProviderConfig(provider);
    if (!config) {
      reply.status(503).send({ error: 'oauth_provider_not_configured', provider });
      return;
    }

    const accessToken = await exchangeCodeForAccessToken(config, body.code, state.codeVerifier);
    if (!accessToken) {
      reply.status(401).send({ error: 'social_auth_failed' });
      return;
    }

    const info = await fetchUserInfo(config, accessToken);
    if (!info) {
      reply.status(401).send({ error: 'social_auth_failed' });
      return;
    }

    const profile = profileFromUserInfo(provider, info);
    if (!profile.subject) {
      reply.status(401).send({ error: 'social_auth_failed' });
      return;
    }

    const existing = await getIdentityBinding('social', provider, profile.subject);
    if (existing) {
      const user = await getUserById(existing.userId);
      if (!user) {
        reply.status(500).send({ error: 'user_not_found' });
        return;
      }

      // Refresh last-seen timestamp for the binding.
      await saveIdentityBinding({
        walletAddress: user.wallet_address,
        method: 'social',
        provider,
        subject: profile.subject,
        userId: user.id,
        lastSeenAt: Date.now(),
      });

      const token = createSessionToken({ userId: user.id });
      await auditLog(user.id, 'social_authenticated', {
        provider,
        subject: profile.subject,
        termsVersion: body.termsVersion || null,
        termsAcceptedAt: body.termsAcceptedAt || null,
      });

      reply.send({ ok: true, provider, user: sanitizeUser(user), token });
      return;
    }

    const created = await createUserWithCustodialWallet();
    let user = await getUserById(created.userId);
    if (!user) {
      reply.status(500).send({ error: 'user_create_failed' });
      return;
    }

    const handleCandidate = profile.handleHint ? safeHandleFromHint(profile.handleHint) : null;
    if (handleCandidate) {
      const existingHandle = await findUserByHandle(handleCandidate);
      if (!existingHandle) {
        user = await updateUser({ id: user.id, handle: handleCandidate });
      }
    }

    if (profile.email) {
      user = await updateUser({ id: user.id, email: profile.email, emailVerified: profile.emailVerified ? 1 : 0 });
    }

    await saveIdentityBinding({
      walletAddress: user.wallet_address,
      method: 'social',
      provider,
      subject: profile.subject,
      userId: user.id,
      linkedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    await auditLog(user.id, 'social_registered', {
      provider,
      subject: profile.subject,
      emailPresent: Boolean(profile.email),
      handleAutoAssigned: Boolean(handleCandidate && user.handle === handleCandidate),
      termsVersion: body.termsVersion || null,
      termsAcceptedAt: body.termsAcceptedAt || null,
    });

    const token = createSessionToken({ userId: user.id });
    reply.send({ ok: true, provider, user: sanitizeUser(user), token });
  });
}

