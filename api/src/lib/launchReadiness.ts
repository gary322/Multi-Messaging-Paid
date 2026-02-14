import { closeChainClients, getLatestBlockNumber, isValidChainAddress } from '../services/chain';
import { closePostgresPool, isPostgresEnabled, queryPostgres } from './postgres';
import { closeRedisClient, getRedisClient, isRedisEnabled } from './redis';
import { getNotificationProviderReadiness } from '../services/notifications';
import { getSocialOAuthProviderReadiness } from '../services/socialOAuth';
import { env } from '../config/env';
import { evaluateCompliance, type ComplianceCheck } from '../services/compliance';

type ComplianceStatus = 'pass' | 'warn' | 'fail';

export type LaunchReadinessCheck = ComplianceCheck & {
  source: 'launch-gate';
};

type LaunchReadinessSummary = {
  pass: number;
  warn: number;
  fail: number;
};

export type LaunchReadinessReport = {
  launchReady: boolean;
  checks: LaunchReadinessCheck[];
  summary: LaunchReadinessSummary;
};

function statusFromCondition(ok: boolean, warnOnly = false): ComplianceStatus {
  if (ok) return 'pass';
  return warnOnly ? 'warn' : 'fail';
}

function countByStatus(checks: LaunchReadinessCheck[]): LaunchReadinessSummary {
  return checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function isSocialProviderAllowed(provider: string) {
  const normalized = provider.toLowerCase();
  return ['google', 'github', 'twitter'].includes(normalized);
}

function isPasskeyProviderAllowed(provider: string) {
  const normalized = provider.toLowerCase();
  return ['apple', 'google'].includes(normalized);
}

function evaluateIdentityGatePolicy() {
  const checks: LaunchReadinessCheck[] = [];
  if (!env.IDENTITY_VERIFICATION_STRICT) {
    checks.push({
      source: 'launch-gate',
      key: 'identity_verification_gate_mode',
      status: 'pass',
      message: 'IDENTITY_VERIFICATION_STRICT is disabled.',
      evidence: {
        strict: false,
      },
    });
    return checks;
  }

  const allowList = env.IDENTITY_ALLOWED_PROVIDERS;
  const socialAllowed = allowList.length === 0 || allowList.some((item) => isSocialProviderAllowed(item));
  const passkeyAllowed = allowList.length === 0 || allowList.some((item) => isPasskeyProviderAllowed(item));

  const socialOauthProviders = getSocialOAuthProviderReadiness().filter((item) => item.configured);
  const socialOauthReady = socialOauthProviders.length > 0;
  const passkeyLocalReady = Boolean(env.PASSKEY_RP_ID && env.PASSKEY_ORIGIN);

  checks.push({
    source: 'launch-gate',
    key: 'identity_remote_social_verifier_required',
    status: statusFromCondition(!socialAllowed || Boolean(env.SOCIAL_VERIFY_URL) || socialOauthReady),
    message: !socialAllowed
      ? 'Social identity is not an enabled provider in strict mode.'
      : env.SOCIAL_VERIFY_URL
        ? 'Social identity verification is configured via remote verifier.'
        : socialOauthReady
          ? `Social identity verification is configured via OAuth (${socialOauthProviders
              .map((item) => item.provider)
              .join(', ')}).`
          : 'Social identity verification is enabled but no remote verifier or OAuth config is present.',
    evidence: {
      strictMode: true,
      socialAllowed,
      socialVerifyUrl: env.SOCIAL_VERIFY_URL || null,
      socialOauthReady,
      socialOauthProviders: socialOauthProviders.map((item) => item.provider),
      identityAllowedProviders: allowList,
    },
  });

  checks.push({
    source: 'launch-gate',
    key: 'identity_remote_passkey_verifier_required',
    status: statusFromCondition(!passkeyAllowed || Boolean(env.PASSKEY_VERIFY_URL) || passkeyLocalReady),
    message: !passkeyAllowed
      ? 'Passkey identity is not an enabled provider in strict mode.'
      : env.PASSKEY_VERIFY_URL
        ? 'Passkey identity verification is configured via remote verifier.'
        : passkeyLocalReady
          ? 'Passkey identity verification is configured via local WebAuthn.'
          : 'Passkey identity verification is enabled but no remote verifier or local RP config is present.',
    evidence: {
      strictMode: true,
      passkeyAllowed,
      passkeyVerifyUrl: env.PASSKEY_VERIFY_URL || null,
      passkeyLocalReady,
      passkeyRpId: env.PASSKEY_RP_ID || null,
      passkeyOrigin: env.PASSKEY_ORIGIN || null,
      identityAllowedProviders: allowList,
    },
  });

  return checks;
}

async function evaluatePersistenceGate() {
  const checks: LaunchReadinessCheck[] = [];

  if (env.DATABASE_BACKEND === 'postgres') {
    checks.push({
      source: 'launch-gate',
      key: 'postgres_url_configured',
      status: statusFromCondition(Boolean(env.DATABASE_URL)),
      message: env.DATABASE_URL
        ? 'DATABASE_URL is configured for Postgres backend.'
        : 'DATABASE_URL is required when DATABASE_BACKEND=postgres.',
      evidence: {
        backend: env.DATABASE_BACKEND,
        databaseUrl: env.DATABASE_URL ? 'set' : 'missing',
      },
    });

    if (env.DATABASE_URL) {
      try {
        await queryPostgres('SELECT 1');
        checks.push({
          source: 'launch-gate',
          key: 'postgres_connectivity',
          status: 'pass',
          message: 'Postgres is reachable for launch readiness checks.',
          evidence: {
            backend: 'postgres',
          },
        });
      } catch (error) {
        checks.push({
          source: 'launch-gate',
          key: 'postgres_connectivity',
          status: 'fail',
          message: `Postgres connectivity check failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } else {
    checks.push({
      source: 'launch-gate',
      key: 'sqlite_profile',
      status: statusFromCondition(!env.PERSISTENCE_STRICT_MODE),
      message: env.PERSISTENCE_STRICT_MODE
        ? 'SQLite backend is forbidden when PERSISTENCE_STRICT_MODE is enabled.'
        : 'SQLite backend is selected; strict persistence requirements are disabled.',
      evidence: {
        backend: env.DATABASE_BACKEND,
      },
    });
  }

  return checks;
}

async function evaluateWorkerGate() {
  const checks: LaunchReadinessCheck[] = [];
  checks.push({
    source: 'launch-gate',
    key: 'distributed_worker_redis_config',
    status: statusFromCondition(!env.WORKER_DISTRIBUTED || Boolean(env.REDIS_URL)),
    message: !env.WORKER_DISTRIBUTED
      ? 'Distributed worker mode is disabled.'
      : env.REDIS_URL
        ? 'Redis URL is configured for distributed worker mode.'
        : 'REDIS_URL is required when WORKER_DISTRIBUTED is enabled.',
    evidence: {
      workerDistributed: env.WORKER_DISTRIBUTED,
      redisConfigured: Boolean(env.REDIS_URL),
    },
  });

  if (env.WORKER_DISTRIBUTED) {
    const redis = getRedisClient();
    if (!redis) {
      checks.push({
        source: 'launch-gate',
        key: 'distributed_worker_redis_reachable',
        status: 'fail',
        message: 'Redis client failed to initialize.',
      });
    } else {
      try {
        const ping = await redis.ping();
        checks.push({
          source: 'launch-gate',
          key: 'distributed_worker_redis_reachable',
          status: statusFromCondition(ping === 'PONG' || ping === true || ping === 'pong'),
          message: ping === 'PONG' || ping === true || ping === 'pong'
            ? 'Redis ping returned healthy response.'
            : `Redis ping returned unexpected response: ${String(ping)}`,
        });
      } catch (error) {
        checks.push({
          source: 'launch-gate',
          key: 'distributed_worker_redis_reachable',
          status: 'fail',
          message: `Redis ping failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return checks;
}

async function evaluateChainGate() {
  const checks: LaunchReadinessCheck[] = [];
  checks.push({
    source: 'launch-gate',
    key: 'chain_indexer_dependency',
    status: statusFromCondition(!env.CHAIN_INDEXER_ENABLED || Boolean(env.CHAIN_RPC_URL && env.CHAIN_VAULT_ADDRESS)),
    message: !env.CHAIN_INDEXER_ENABLED
      ? 'Indexer worker is disabled.'
      : env.CHAIN_RPC_URL && env.CHAIN_VAULT_ADDRESS
        ? 'Chain indexer has RPC and vault address configured.'
        : 'CHAIN_INDEXER_ENABLED requires CHAIN_RPC_URL and CHAIN_VAULT_ADDRESS.',
    evidence: {
      chainIndexerEnabled: env.CHAIN_INDEXER_ENABLED,
      chainRpc: Boolean(env.CHAIN_RPC_URL),
      chainVaultAddress: Boolean(env.CHAIN_VAULT_ADDRESS),
    },
  });

  if (!env.CHAIN_INDEXER_ENABLED) {
    return checks;
  }

  if (env.CHAIN_VAULT_ADDRESS) {
    checks.push({
      source: 'launch-gate',
      key: 'chain_vault_address_valid',
      status: statusFromCondition(isValidChainAddress(env.CHAIN_VAULT_ADDRESS)),
      message: isValidChainAddress(env.CHAIN_VAULT_ADDRESS)
        ? 'CHAIN_VAULT_ADDRESS is a valid chain address.'
        : 'CHAIN_VAULT_ADDRESS is invalid.',
      evidence: {
        chainVaultAddress: env.CHAIN_VAULT_ADDRESS,
      },
    });
  }

  if (env.CHAIN_RPC_URL) {
    try {
      const latest = await getLatestBlockNumber(env.CHAIN_RPC_URL);
      checks.push({
        source: 'launch-gate',
        key: 'chain_rpc_connectivity',
        status: statusFromCondition(Number.isFinite(latest) && latest >= 0),
        message: `Chain RPC responded with latest block: ${latest}.`,
        evidence: {
          rpcUrl: env.CHAIN_RPC_URL,
          latestBlock: latest,
        },
      });
    } catch (error) {
      checks.push({
        source: 'launch-gate',
        key: 'chain_rpc_connectivity',
        status: 'fail',
        message: `Chain RPC connectivity failed: ${error instanceof Error ? error.message : String(error)}`,
        evidence: {
          rpcUrl: env.CHAIN_RPC_URL,
        },
      });
    }
  }

  return checks;
}

function evaluateNotificationGate() {
  const checks: LaunchReadinessCheck[] = [];
  const providers = getNotificationProviderReadiness();
  const configured = providers.filter((item) => item.configured);
  const ready = providers.filter((item) => item.configured && item.hasAuthToken);

  if (env.NOTIFICATION_PROVIDERS_STRICT) {
    checks.push({
      source: 'launch-gate',
      key: 'notification_provider_strict_ready',
      status: statusFromCondition(ready.length > 0),
      message:
        ready.length > 0
          ? 'Notification provider(s) are configured and authenticated.'
          : 'NOTIFICATION_PROVIDERS_STRICT=true requires at least one authenticated provider.',
      evidence: {
        configured: configured.map((item) => item.provider),
        ready: ready.map((item) => item.provider),
      },
    });
  } else {
    checks.push({
      source: 'launch-gate',
      key: 'notification_provider_optional',
      status: statusFromCondition(Boolean(configured.length), true),
      message: configured.length > 0
        ? 'At least one notification provider is configured.'
        : 'No notification provider configured. In-app delivery remains active.',
      evidence: {
        configured: configured.map((item) => item.provider),
      },
    });
  }

  return checks;
}

export async function getLaunchReadiness(): Promise<LaunchReadinessReport> {
  const compliance = evaluateCompliance();
  const checks: LaunchReadinessCheck[] = [
    ...compliance.checks.map((check): LaunchReadinessCheck => ({
      ...check,
      source: 'launch-gate',
    })),
    ...evaluateIdentityGatePolicy(),
    ...(await evaluatePersistenceGate()),
    ...(await evaluateWorkerGate()),
    ...(await evaluateChainGate()),
    ...evaluateNotificationGate(),
  ];

  const summary = countByStatus(checks);
  const launchReady =
    (!env.COMPLIANCE_BLOCK_ON_WARN && summary.fail === 0) ||
    (env.COMPLIANCE_BLOCK_ON_WARN && summary.fail === 0 && summary.warn === 0);

  return {
    launchReady,
    checks,
    summary,
  };
}

export async function assertLaunchReady() {
  const report = await getLaunchReadiness();
  if (report.launchReady) {
    return report;
  }

  if (isRedisEnabled()) {
    await closeRedisClient();
  }
  if (isPostgresEnabled()) {
    await closePostgresPool();
  }
  if (env.CHAIN_INDEXER_ENABLED || env.CHAIN_RPC_URL) {
    await closeChainClients();
  }
  throw new Error(`launch readiness checks failed: ${report.summary.fail} fail(s), ${report.summary.warn} warn(s)`);
}
