import http from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createServer } from '../src/index';
import { env } from '../src/config/env';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

type FakeOAuthServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startFakeOAuthServer(): Promise<FakeOAuthServer> {
  const codes = new Map<string, { provider: 'google' | 'github'; codeChallenge: string; subject: string }>();
  const tokens = new Map<string, { provider: 'google' | 'github'; subject: string }>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname.endsWith('/authorize')) {
      const state = url.searchParams.get('state') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const codeChallenge = url.searchParams.get('code_challenge') || '';
      const provider = url.pathname.includes('/google/') ? 'google' : 'github';
      const subject = provider === 'google' ? 'google-subject-1' : '12345';
      const code = `code-${randomUUID()}`;
      codes.set(code, { provider, codeChallenge, subject });
      const redirect = new URL(redirectUri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', state);
      res.statusCode = 302;
      res.setHeader('location', redirect.toString());
      res.end();
      return;
    }

    if (url.pathname.endsWith('/token')) {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        const params = new URLSearchParams(raw);
        const code = params.get('code') || '';
        const verifier = params.get('code_verifier') || '';
        const entry = codes.get(code);
        if (!entry) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid_code' }));
          return;
        }
        const expected = require('node:crypto').createHash('sha256').update(verifier).digest('base64url');
        if (!verifier || expected !== entry.codeChallenge) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid_verifier' }));
          return;
        }
        const token = `token-${randomUUID()}`;
        tokens.set(token, { provider: entry.provider, subject: entry.subject });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: token, token_type: 'bearer' }));
      });
      return;
    }

    if (url.pathname.endsWith('/userinfo') || url.pathname.endsWith('/user')) {
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      const record = tokens.get(token);
      if (!record) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      if (record.provider === 'google') {
        res.end(JSON.stringify({ sub: record.subject, email: 'user@example.com', email_verified: true }));
      } else {
        res.end(JSON.stringify({ id: Number(record.subject), login: 'octocat' }));
      }
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed_to_bind_fake_oauth_server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('social oauth', () => {
  it('supports google oauth start/exchange and creates a custodial wallet user', async () => {
    const fake = await startFakeOAuthServer();

    await withEnv(
      {
        OAUTH_GOOGLE_CLIENT_ID: 'google-client',
        OAUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
        OAUTH_GOOGLE_REDIRECT_URI: 'https://app.test/callback',
        OAUTH_GOOGLE_AUTH_URL: `${fake.baseUrl}/google/authorize`,
        OAUTH_GOOGLE_TOKEN_URL: `${fake.baseUrl}/google/token`,
        OAUTH_GOOGLE_USERINFO_URL: `${fake.baseUrl}/google/userinfo`,
      },
      async () => {
        const app = await createServer();

        const start = await request(app.server).post('/v1/auth/social/google/start').send({});
        expect(start.status).toBe(200);
        expect(start.body.provider).toBe('google');
        expect(start.body.authorizationUrl).toContain('/google/authorize');

        const authRes = await fetch(start.body.authorizationUrl, { redirect: 'manual' });
        expect(authRes.status).toBe(302);
        const location = authRes.headers.get('location');
        expect(location).toBeTruthy();

        const redirected = new URL(location || 'https://app.test/callback');
        const code = redirected.searchParams.get('code');
        const state = redirected.searchParams.get('state');
        expect(code).toBeTruthy();
        expect(state).toBe(start.body.state);

        const exchange = await request(app.server).post('/v1/auth/social/google/exchange').send({
          state,
          code,
        });
        expect(exchange.status).toBe(200);
        expect(exchange.body.ok).toBe(true);
        expect(exchange.body.provider).toBe('google');
        expect(exchange.body.user?.id).toBeTruthy();
        expect(exchange.body.user?.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(exchange.body.token).toMatch(/^mmp\./);

        // Second login should map back to same user.
        const start2 = await request(app.server).post('/v1/auth/social/google/start').send({});
        const authRes2 = await fetch(start2.body.authorizationUrl, { redirect: 'manual' });
        const redirected2 = new URL(authRes2.headers.get('location') || 'https://app.test/callback');
        const exchange2 = await request(app.server).post('/v1/auth/social/google/exchange').send({
          state: redirected2.searchParams.get('state'),
          code: redirected2.searchParams.get('code'),
        });
        expect(exchange2.status).toBe(200);
        expect(exchange2.body.user.id).toBe(exchange.body.user.id);
        expect(exchange2.body.user.walletAddress).toBe(exchange.body.user.walletAddress);

        await app.close();
      },
    );

    await fake.close();
  });

  it('enforces terms acceptance when social tos gating is enabled', async () => {
    const fake = await startFakeOAuthServer();

    await withEnv(
      {
        REQUIRE_SOCIAL_TOS_ACCEPTED: true,
        LEGAL_TOS_VERSION: 'v2026-02-13',
        OAUTH_GITHUB_CLIENT_ID: 'github-client',
        OAUTH_GITHUB_CLIENT_SECRET: 'github-secret',
        OAUTH_GITHUB_REDIRECT_URI: 'https://app.test/callback',
        OAUTH_GITHUB_AUTH_URL: `${fake.baseUrl}/github/authorize`,
        OAUTH_GITHUB_TOKEN_URL: `${fake.baseUrl}/github/token`,
        OAUTH_GITHUB_USERINFO_URL: `${fake.baseUrl}/github/user`,
      },
      async () => {
        const app = await createServer();
        const start = await request(app.server).post('/v1/auth/social/github/start').send({});
        const authRes = await fetch(start.body.authorizationUrl, { redirect: 'manual' });
        const redirected = new URL(authRes.headers.get('location') || 'https://app.test/callback');
        const state = redirected.searchParams.get('state');
        const code = redirected.searchParams.get('code');

        const exchangeMissing = await request(app.server).post('/v1/auth/social/github/exchange').send({
          state,
          code,
        });
        expect(exchangeMissing.status).toBe(403);
        expect(exchangeMissing.body.error).toBe('compliance_required');

        const exchange = await request(app.server).post('/v1/auth/social/github/exchange').send({
          state,
          code,
          termsVersion: 'v2026-02-13',
          termsAcceptedAt: Date.now(),
        });
        expect(exchange.status).toBe(200);
        expect(exchange.body.ok).toBe(true);
        await app.close();
      },
    );

    await fake.close();
  });

  it('requires redis when strict persistence mode is enabled', async () => {
    const fake = await startFakeOAuthServer();

    await withEnv(
      {
        PERSISTENCE_STRICT_MODE: true,
        // Strict persistence mode implies Postgres. Avoid real connectivity in this unit test by
        // disabling migrations and providing a dummy DATABASE_URL.
        DATABASE_BACKEND: 'postgres',
        DATABASE_URL: 'postgresql://mmp:mmp@127.0.0.1:5432/mmp',
        DATABASE_MIGRATIONS_ON_START: false,
        WORKER_DISTRIBUTED: false,
        REDIS_URL: '',
        OAUTH_GOOGLE_CLIENT_ID: 'google-client',
        OAUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
        OAUTH_GOOGLE_REDIRECT_URI: 'https://app.test/callback',
        OAUTH_GOOGLE_AUTH_URL: `${fake.baseUrl}/google/authorize`,
        OAUTH_GOOGLE_TOKEN_URL: `${fake.baseUrl}/google/token`,
        OAUTH_GOOGLE_USERINFO_URL: `${fake.baseUrl}/google/userinfo`,
      },
      async () => {
        // This test asserts Redis is required for OAuth state persistence in strict mode. It does not
        // need a real Postgres connection, so skip the global resetStore() hook (set via MMP_RESET_STORE=1
        // in the test script) to avoid attempting to connect to Postgres during createServer().
        const resetSnapshot = process.env.MMP_RESET_STORE;
        process.env.MMP_RESET_STORE = '0';
        const app = await createServer();
        try {
          const start = await request(app.server).post('/v1/auth/social/google/start').send({});
          expect(start.status).toBe(503);
          expect(start.body.error).toBe('redis_required');
        } finally {
          await app.close();
          if (resetSnapshot === undefined) {
            delete process.env.MMP_RESET_STORE;
          } else {
            process.env.MMP_RESET_STORE = resetSnapshot;
          }
        }
      },
    );

    await fake.close();
  });
});
