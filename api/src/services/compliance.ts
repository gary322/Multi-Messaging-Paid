import { env } from '../config/env';
import { getNotificationProviderReadiness } from './notifications';
import { getOtpProviderReadiness } from './otp';
import { getSocialOAuthProviderReadiness } from './socialOAuth';

export type ComplianceStatus = 'pass' | 'warn' | 'fail';
export type ComplianceCheck = {
  key: string;
  status: ComplianceStatus;
  message: string;
  evidence?: Record<string, any>;
};

export type ComplianceReport = {
  launchReady: boolean;
  checks: ComplianceCheck[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
};

function statusFromCondition(ok: boolean, warnOnly = false): ComplianceStatus {
  if (ok) return 'pass';
  return warnOnly ? 'warn' : 'fail';
}

function safeDefaultSessionSecret(secret: string) {
  return secret.length < 24 || secret.includes('rotate-me');
}

function safeDefaultKey(secret: string) {
  return secret.length < 24 || secret.includes('rotate-me');
}

function countByStatus(checks: ComplianceCheck[]) {
  return checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function checkAuthAndWallet() {
  const checks: ComplianceCheck[] = [];
  checks.push({
    key: 'session_secret',
    status: statusFromCondition(!safeDefaultSessionSecret(env.SESSION_SECRET)),
    message: safeDefaultSessionSecret(env.SESSION_SECRET)
      ? 'SESSION_SECRET must be strong and rotated in production.'
      : 'SESSION_SECRET is set and not obviously default.',
  });
  checks.push({
    key: 'smart_account_derivation_key',
    status: statusFromCondition(!safeDefaultKey(env.SMART_ACCOUNT_DERIVATION_KEY || '')),
    message: safeDefaultKey(env.SMART_ACCOUNT_DERIVATION_KEY || '')
      ? 'SMART_ACCOUNT_DERIVATION_KEY must be strong and rotated in production.'
      : 'SMART_ACCOUNT_DERIVATION_KEY is set and not obviously default.',
  });
  checks.push({
    key: 'pii_hash_key',
    status: statusFromCondition(!safeDefaultKey(env.PII_HASH_KEY || '')),
    message: safeDefaultKey(env.PII_HASH_KEY || '')
      ? 'PII_HASH_KEY must be strong and rotated in production.'
      : 'PII_HASH_KEY is set and not obviously default.',
  });
  checks.push({
    key: 'smart_account_support',
    status: statusFromCondition(Boolean(env.PASSKEY_SOCIAL_NAMESPACE) && Boolean(env.PASSKEY_SOCIAL_NAMESPACE.trim())),
    message: 'PASSKEY_SOCIAL_NAMESPACE configured.',
  });

  checks.push({
    key: 'identity_provider_config',
    status: statusFromCondition(
      Boolean(env.SOCIAL_VERIFY_URL || env.PASSKEY_VERIFY_URL || env.IDENTITY_ALLOWED_PROVIDERS.length === 0),
      true,
    ),
    message: env.SOCIAL_VERIFY_URL || env.PASSKEY_VERIFY_URL
      ? 'Identity remote verification endpoint(s) are configured.'
      : 'Identity verifier endpoints are not configured; local verification fallback is active.',
    evidence: {
      socialVerifyUrl: env.SOCIAL_VERIFY_URL || null,
      passkeyVerifyUrl: env.PASSKEY_VERIFY_URL || null,
      allowListEnabled: env.IDENTITY_ALLOWED_PROVIDERS.length > 0,
      providerAllowList: env.IDENTITY_ALLOWED_PROVIDERS,
    },
  });

  const socialOauth = getSocialOAuthProviderReadiness();
  const socialOauthConfigured = socialOauth.filter((item) => item.configured).map((item) => item.provider);
  const passkeyLocalReady = Boolean(env.PASSKEY_RP_ID && env.PASSKEY_ORIGIN);
  checks.push({
    key: 'social_oauth_provider_config',
    status: statusFromCondition(socialOauthConfigured.length > 0, true),
    message:
      socialOauthConfigured.length > 0
        ? `Social OAuth provider(s) configured: ${socialOauthConfigured.join(', ')}.`
        : 'No Social OAuth providers configured (Google/GitHub). Social login is unavailable unless remote verifiers are used.',
    evidence: {
      configured: socialOauthConfigured,
      providers: socialOauth,
    },
  });

  checks.push({
    key: 'identity_verification_enforced',
    status: statusFromCondition(
      !env.IDENTITY_VERIFICATION_STRICT ||
        Boolean(env.SOCIAL_VERIFY_URL) ||
        Boolean(env.PASSKEY_VERIFY_URL) ||
        socialOauthConfigured.length > 0 ||
        passkeyLocalReady,
      true,
    ),
    message: env.IDENTITY_VERIFICATION_STRICT
      ? 'Strict identity verification is enabled; configure remote verifiers or local OAuth/passkey providers.'
      : 'Strict identity verification is disabled for non-production verification fallback.',
    evidence: {
      strictMode: env.IDENTITY_VERIFICATION_STRICT,
      socialVerifyUrl: env.SOCIAL_VERIFY_URL || null,
      passkeyVerifyUrl: env.PASSKEY_VERIFY_URL || null,
      socialOauthConfigured,
      passkeyLocalReady,
    },
  });

  checks.push({
    key: 'identity_terms_controls',
    status: statusFromCondition(!env.REQUIRE_SOCIAL_TOS_ACCEPTED || Boolean(env.LEGAL_TOS_APPROVED_AT), true),
    message: env.REQUIRE_SOCIAL_TOS_ACCEPTED
      ? 'Social/passkey flow requires legal approval before auth.'
      : 'Social/passkey terms gating is disabled.',
    evidence: {
      requireSocialTos: env.REQUIRE_SOCIAL_TOS_ACCEPTED,
      legalApprovedAt: env.LEGAL_TOS_APPROVED_AT || null,
    },
  });
  return checks;
}

function checkProviderReadiness() {
  const checks: ComplianceCheck[] = [];
  const providers = getNotificationProviderReadiness();
  const telegram = providers.find((item) => item.provider === 'telegram');
  const whatsapp = providers.find((item) => item.provider === 'whatsapp');
  const x = providers.find((item) => item.provider === 'x');

  const telegramReady = Boolean(telegram?.configured);
  const whatsappReady = Boolean(whatsapp?.configured);
  const xReady = Boolean(x?.configured);
  const providerConfiguredButNoToken = {
    whatsapp: whatsappReady && !whatsapp?.hasAuthToken,
    x: xReady && !x?.hasAuthToken,
  };
  const allProviderConfig = telegramReady || whatsappReady || xReady;

  const allEnabledInComplianceMode = allProviderConfig;

  checks.push({
    key: 'notification_provider',
    status: statusFromCondition(allEnabledInComplianceMode, true),
    message: allEnabledInComplianceMode
      ? 'At least one notification provider integration is configured.'
      : 'No notification provider configured. In-app delivery still works.',
    evidence: {
      telegram: telegramReady,
      whatsapp: whatsappReady,
      x: xReady,
      provider: providers,
      xMissingToken: providerConfiguredButNoToken.x,
      whatsappMissingToken: providerConfiguredButNoToken.whatsapp,
    },
  });

  checks.push({
    key: 'notification_whatsapp_x_opt_in',
    status: statusFromCondition(!env.REQUIRE_SOCIAL_TOS_ACCEPTED || Boolean(env.LEGAL_TOS_APPROVED_AT), true),
    message: env.REQUIRE_SOCIAL_TOS_ACCEPTED
      ? 'Social/whatsapp/x opt-in acceptance policy is configured.'
      : 'Social opt-in policy is disabled via REQUIRE_SOCIAL_TOS_ACCEPTED.',
    evidence: {
      requireTosAccepted: env.REQUIRE_SOCIAL_TOS_ACCEPTED,
      legalApprovedAt: env.LEGAL_TOS_APPROVED_AT || null,
    },
  });
  return checks;
}

function checkObservabilityReadiness() {
  const checks: ComplianceCheck[] = [];

  const metricsOk =
    env.METRICS_ENABLED && (env.NODE_ENV !== 'production' || Boolean(env.METRICS_ROUTE_TOKEN));
  checks.push({
    key: 'observability_metrics',
    status: statusFromCondition(metricsOk, true),
    message: metricsOk
      ? 'Metrics endpoint is enabled and protected.'
      : env.METRICS_ENABLED
        ? 'METRICS_ENABLED is set, but METRICS_ROUTE_TOKEN is missing (required in production).'
        : 'METRICS_ENABLED is disabled; enable metrics for production observability.',
    evidence: {
      metricsEnabled: env.METRICS_ENABLED,
      metricsTokenConfigured: Boolean(env.METRICS_ROUTE_TOKEN),
      production: env.NODE_ENV === 'production',
    },
  });

  const tracesOk = !env.OTEL_TRACING_ENABLED || Boolean(env.OTEL_TRACES_EXPORT_URL);
  checks.push({
    key: 'observability_traces',
    status: statusFromCondition(tracesOk, true),
    message: tracesOk
      ? 'Tracing export is configured.'
      : 'OTEL_TRACING_ENABLED is true but OTEL_TRACES_EXPORT_URL is missing.',
    evidence: {
      otelEnabled: env.OTEL_TRACING_ENABLED,
      exportUrlConfigured: Boolean(env.OTEL_TRACES_EXPORT_URL),
    },
  });

  return checks;
}

function checkOtpProviderReadiness() {
  const checks: ComplianceCheck[] = [];
  const otpProviders = getOtpProviderReadiness();
  const isProd = env.NODE_ENV === 'production';

  for (const provider of otpProviders) {
    const isConsole = provider.provider === 'console';
    const disabled = provider.provider === 'disabled' || provider.configured === false;
    const hasAuth = provider.hasAuthToken;

    const ok = !disabled && !isConsole && hasAuth;
    const warnOnly = !isProd;

    checks.push({
      key: provider.channel === 'phone' ? 'otp_sms_provider' : 'otp_email_provider',
      status: statusFromCondition(ok, warnOnly),
      message: ok
        ? `${provider.channel.toUpperCase()} OTP provider ${provider.provider} is configured.`
        : disabled
          ? `${provider.channel.toUpperCase()} OTP provider is disabled; real OTP delivery is required for production.`
          : isConsole
            ? `${provider.channel.toUpperCase()} OTP provider is console; configure a real provider for production.`
            : `${provider.channel.toUpperCase()} OTP provider ${provider.provider} is missing credentials.`,
      evidence: {
        channel: provider.channel,
        provider: provider.provider,
        configured: provider.configured,
        hasAuthToken: provider.hasAuthToken,
        production: isProd,
      },
    });
  }

  return checks;
}

function checkDataInfrastructureReadiness() {
  const checks: ComplianceCheck[] = [];

  checks.push({
    key: 'db_backend',
    status: statusFromCondition(env.DATABASE_BACKEND === 'postgres' || env.NODE_ENV !== 'production', true),
    message:
      env.DATABASE_BACKEND === 'postgres'
        ? 'PostgreSQL backend configured.'
        : 'SQLite fallback in use (not recommended for multi-instance production).',
    evidence: {
      backend: env.DATABASE_BACKEND || 'sqlite',
      databaseUrlConfigured: Boolean(env.DATABASE_URL),
      pathFallback: env.DATABASE_PATH || '',
    },
  });

  checks.push({
    key: 'distributed_cache',
    status: statusFromCondition(Boolean(env.REDIS_URL), true),
    message: env.REDIS_URL ? 'Redis configured.' : 'Redis not configured; distributed locks are disabled.',
    evidence: {
      redisConfigured: Boolean(env.REDIS_URL),
      workerDistributed: env.WORKER_DISTRIBUTED,
    },
  });

  checks.push({
    key: 'distributed_worker_locking',
    status: statusFromCondition(!env.WORKER_DISTRIBUTED || Boolean(env.REDIS_URL), false),
    message: env.WORKER_DISTRIBUTED
      ? env.REDIS_URL
        ? 'Worker distributed mode has Redis lock backend.'
        : 'Distributed worker mode enabled without Redis. This is not safe for multi-instance deployments.'
      : 'Distributed mode disabled. Single instance safe for local testing.',
    evidence: {
      workerDistributed: env.WORKER_DISTRIBUTED,
      redisConfigured: Boolean(env.REDIS_URL),
    },
  });

  return checks;
}

function checkLegalReadiness() {
  const checks: ComplianceCheck[] = [];
  const tosVersion = env.LEGAL_TOS_VERSION;
  checks.push({
    key: 'legal_tos_version',
    status: statusFromCondition(Boolean(tosVersion && tosVersion !== 'v1'), true),
    message: tosVersion
      ? `Legal terms version is set to ${tosVersion}.`
      : 'LEGAL_TOS_VERSION is missing.',
  });

  checks.push({
    key: 'legal_tos_policy_url',
    status: statusFromCondition(Boolean(env.LEGAL_POLICY_DOC_URL), true),
    message: env.LEGAL_POLICY_DOC_URL
      ? `Legal policy link is configured: ${env.LEGAL_POLICY_DOC_URL}`
      : 'LEGAL_POLICY_DOC_URL is not configured.',
  });

  checks.push({
    key: 'legal_tos_policy_doc',
    status: statusFromCondition(Boolean(env.LEGAL_POLICY_DOC_URL), true),
    message: env.LEGAL_POLICY_DOC_URL
      ? 'Legal policy document URL is available for compliance checks.'
      : 'Legal policy document URL is missing.',
    evidence: {
      legalPolicyDocUrl: env.LEGAL_POLICY_DOC_URL || null,
    },
  });

  if (env.REQUIRE_SOCIAL_TOS_ACCEPTED && !env.LEGAL_TOS_APPROVED_AT) {
    checks.push({
      key: 'legal_tos_approved',
      status: 'warn',
      message: 'REQUIRE_SOCIAL_TOS_ACCEPTED is enabled, but LEGAL_TOS_APPROVED_AT is missing.',
      evidence: {
        legalApprovedAt: env.LEGAL_TOS_APPROVED_AT || null,
      },
    });
  }

  return checks;
}

export function evaluateCompliance(): ComplianceReport {
  const checks = [
    ...checkAuthAndWallet(),
    ...checkDataInfrastructureReadiness(),
    ...checkProviderReadiness(),
    ...checkOtpProviderReadiness(),
    ...checkObservabilityReadiness(),
    ...checkLegalReadiness(),
  ];
  const summary = countByStatus(checks);
  const launchReady =
    (!env.COMPLIANCE_BLOCK_ON_WARN && summary.fail === 0) ||
    (env.COMPLIANCE_BLOCK_ON_WARN && summary.fail === 0 && summary.warn === 0);
  return { launchReady, checks, summary };
}
