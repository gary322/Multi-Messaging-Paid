import { createHmac, randomUUID } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { env } from '../config/env';
import { deriveSmartWalletAddress } from './smartAccount';

export type IdentityMethod = 'wallet' | 'passkey' | 'social';

export type IdentityProviderProfile = {
  method: IdentityMethod;
  provider: string;
  requiresRemoteVerifier: boolean;
};

export type ResolvedIdentity = {
  walletAddress: string;
  provider: string;
  subject: string;
  method: IdentityMethod;
};

type RemoteIdentityResponse = {
  ok?: boolean;
  walletAddress?: string;
  subject?: string;
  provider?: string;
  error?: string;
};

type VerifyPayload = {
  method: IdentityMethod;
  provider?: string;
  challenge: string;
  proof: string;
  subject?: string;
};

function normalizeProvider(method: IdentityMethod, provider?: string) {
  if (provider && provider.trim()) return provider.trim().toLowerCase();
  return method === 'wallet' ? 'wallet' : method;
}

export function getSupportedIdentityProviders(method?: IdentityMethod): IdentityProviderProfile[] {
  const base: IdentityProviderProfile[] = [];
  if (method === 'wallet' || !method) {
    base.push({ method: 'wallet', provider: 'wallet', requiresRemoteVerifier: false });
  }
  if (method === 'social' || !method) {
    base.push(
      { method: 'social', provider: 'google', requiresRemoteVerifier: Boolean(env.SOCIAL_VERIFY_URL) },
      { method: 'social', provider: 'github', requiresRemoteVerifier: Boolean(env.SOCIAL_VERIFY_URL) },
      { method: 'social', provider: 'twitter', requiresRemoteVerifier: Boolean(env.SOCIAL_VERIFY_URL) },
    );
  }
  if (method === 'passkey' || !method) {
    base.push(
      { method: 'passkey', provider: 'apple', requiresRemoteVerifier: Boolean(env.PASSKEY_VERIFY_URL) },
      { method: 'passkey', provider: 'google', requiresRemoteVerifier: Boolean(env.PASSKEY_VERIFY_URL) },
    );
  }
  return base;
}

export function isAllowedProvider(method: IdentityMethod, provider: string) {
  if (!env.IDENTITY_ALLOWED_PROVIDERS.length) {
    return true;
  }
  if (method === 'wallet') {
    return provider === 'wallet';
  }
  return env.IDENTITY_ALLOWED_PROVIDERS.includes(provider);
}

export function isConfiguredForMethod(method: IdentityMethod, provider: string) {
  const normalizedProvider = normalizeProvider(method, provider);
  if (!normalizedProvider) {
    return false;
  }
  if (method === 'wallet') {
    return true;
  }
  if (!env.IDENTITY_VERIFICATION_STRICT) {
    return true;
  }
  const verifier = method === 'social' ? env.SOCIAL_VERIFY_URL : env.PASSKEY_VERIFY_URL;
  return Boolean(verifier && verifier.length > 0);
}

function localSharedSecret() {
  return env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET;
}

function proofChallengePayload(method: IdentityMethod, provider: string, challenge: string, subject: string) {
  const audience = method === 'social' ? (env.SOCIAL_AUDIENCE || '') : method === 'passkey' ? (env.PASSKEY_AUDIENCE || '') : '';
  const base = `${method}:${provider}:${subject}:${challenge}`;
  return audience ? `${base}:aud=${audience}` : base;
}

function expectedLocalProof(method: IdentityMethod, provider: string, challenge: string, subject: string) {
  const version = 'v1';
  return createHmac('sha256', localSharedSecret())
    .update(`${version}:${proofChallengePayload(method, provider, challenge, subject)}`)
    .digest('hex');
}

function deriveWallet(method: IdentityMethod, provider: string, subject: string) {
  return deriveSmartWalletAddress({
    provider: `${method}:${provider}`.toLowerCase(),
    subject,
  });
}

async function verifyRemoteIdentity(url: string, payload: VerifyPayload): Promise<string | null> {
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      scope: `${payload.method}:verify`,
      requestId: randomUUID(),
      timeoutMs: env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
    }),
  };

  const response = await fetch(url, request);
  const body = (await response.json().catch(() => null)) as RemoteIdentityResponse | null;
  if (!response.ok || !body || body.ok !== true) {
    return null;
  }
  if (body.provider && body.provider.toLowerCase() !== payload.provider?.toLowerCase()) {
    return null;
  }
  if (payload.subject && body.subject && body.subject !== payload.subject) {
    return null;
  }
  if (typeof body.walletAddress !== 'string') {
    return null;
  }
  const walletAddress = body.walletAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
    return null;
  }
  return walletAddress;
}

async function resolveFromLocalProof(method: IdentityMethod, provider: string, challenge: string, subject: string, proof: string) {
  if (proof.length < 8) return null;
  const expected = expectedLocalProof(method, provider, challenge, subject);
  if (expected !== proof) return null;
  return deriveWallet(method, provider, subject);
}

function resolveFromWalletSignature(challenge: string, proof: string) {
  try {
    const recoveredAddress = verifyMessage(challenge, proof);
    return recoveredAddress ? recoveredAddress.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function resolveIdentityWallet(input: {
  method: IdentityMethod;
  challenge: string;
  proof?: string;
  provider?: string;
  subject?: string;
  expectedWalletAddress?: string | null;
}) {
  const method = input.method;
  const proof = input.proof || '';
  const provider = normalizeProvider(method, input.provider);

  if (!isAllowedProvider(method, provider)) {
    return null;
  }

  let walletAddress: string | null = null;
  if (!isConfiguredForMethod(method, provider)) {
    return null;
  }

  if (method === 'wallet') {
    if (!input.expectedWalletAddress || !proof) {
      return null;
    }
    const recovered = resolveFromWalletSignature(input.challenge, proof);
    if (!recovered || recovered.toLowerCase() !== input.expectedWalletAddress.toLowerCase()) {
      return null;
    }
    walletAddress = recovered;
  } else {
    if (!input.subject) {
      return null;
    }

    const verifier = method === 'social' ? env.SOCIAL_VERIFY_URL : env.PASSKEY_VERIFY_URL;
    if (verifier) {
      try {
        const verified = await verifyRemoteIdentity(verifier, {
          method,
          provider,
          challenge: input.challenge,
          proof,
          subject: input.subject,
        });
        if (verified) {
          walletAddress = verified;
        }
      } catch {
        walletAddress = null;
      }
      if (!walletAddress && env.IDENTITY_VERIFICATION_STRICT) {
        return null;
      }
    }

    if (!walletAddress) {
      walletAddress = await resolveFromLocalProof(method, provider, input.challenge, input.subject, proof);
    }
  }

  if (!walletAddress) {
    return null;
  }
  if (input.expectedWalletAddress && input.expectedWalletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return null;
  }

  return {
    walletAddress,
    provider,
    subject: input.subject || '',
    method,
  };
}

export async function makeAuthChallenge(method: IdentityMethod, provider?: string, subjectHint?: string) {
  const token = createHmac('sha256', localSharedSecret())
    .update(`${Date.now()}-${Math.random()}-${method}-${provider || 'local'}-${subjectHint || 'anonymous'}`)
    .digest('hex')
    .slice(0, 48);
  return `${method}:${provider || 'local'}:${subjectHint || 'anonymous'}:${Date.now()}:${token}`;
}
