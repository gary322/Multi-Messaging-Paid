import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

function parseBool(value: string | undefined, fallback = false) {
  if (value === undefined) return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return fallback;
}

function parseBoolWithProductionDefault(key: string, productionDefault: boolean, fallback = false) {
  return parseBool(process.env[key], isProduction ? productionDefault : fallback);
}

function splitCsvValue(value: string | undefined) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const testWorkerId = process.env.JEST_WORKER_ID;
const dbFallbackFile = (() => {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (process.env.NODE_ENV === 'test') {
    if (testWorkerId) return path.join(process.cwd(), 'data', `mmp-test-${testWorkerId}.sqlite`);
    return path.join(process.cwd(), 'data', `mmp-test-${process.pid}.sqlite`);
  }
  return path.join(process.cwd(), 'data', 'mmp.sqlite');
})();

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 4000),
  DATABASE_URL: process.env.DATABASE_URL || '',
  DATABASE_PATH: dbFallbackFile,
  DATABASE_BACKEND: process.env.DATABASE_BACKEND || 'sqlite',
  DATABASE_POOL_MAX: Number(process.env.DATABASE_POOL_MAX || 5),
  DATABASE_POOL_CONNECT_TIMEOUT_MS: Number(process.env.DATABASE_POOL_CONNECT_TIMEOUT_MS || 2000),
  DATABASE_POOL_IDLE_TIMEOUT_MS: Number(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS || 30_000),
  DATABASE_MIGRATION_SOURCE: process.env.DATABASE_MIGRATION_SOURCE || '',
  PERSISTENCE_STRICT_MODE: parseBoolWithProductionDefault('PERSISTENCE_STRICT_MODE', true),
  REDIS_URL: process.env.REDIS_URL || '',
  REDIS_CONNECT_TIMEOUT_MS: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 1_000),
  WORKER_DISTRIBUTED: parseBoolWithProductionDefault('WORKER_DISTRIBUTED', true),
  APP_URL: process.env.APP_URL || 'http://localhost:4000',
  SESSION_SECRET: process.env.SESSION_SECRET || 'local-dev-session-secret-rotate-me',
  SESSION_TTL_MS: Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000),
  PII_HASH_KEY: process.env.PII_HASH_KEY || 'local-dev-pii-hash-key-rotate-me',
  SMART_ACCOUNT_DERIVATION_KEY: process.env.SMART_ACCOUNT_DERIVATION_KEY || 'local-dev-smart-account-key-rotate-me',
  CHAIN_RPC_URL: process.env.CHAIN_RPC_URL || '',
  CHAIN_VAULT_ADDRESS: process.env.CHAIN_VAULT_ADDRESS || '',
  CHAIN_USDC_ADDRESS: process.env.CHAIN_USDC_ADDRESS || '',
  CHAIN_TOKEN_DECIMALS: Number(process.env.CHAIN_TOKEN_DECIMALS || 6),
  CHAIN_MESSAGE_CHANNEL: Number(process.env.CHAIN_MESSAGE_CHANNEL || 1),
  CHAIN_PAYER_PRIVATE_KEY: process.env.CHAIN_PAYER_PRIVATE_KEY || '',
  INDEXER_WORKER_LOCK_TTL_MS: Number(process.env.INDEXER_WORKER_LOCK_TTL_MS || 30_000),
  CHAIN_PAINBOX: process.env.CHAIN_PAINBOX || '',
  AUTH_CHALLENGE_TTL_MS: Number(process.env.AUTH_CHALLENGE_TTL_MS || 5 * 60 * 1000),
  ENABLE_SQLITE: process.env.ENABLE_SQLITE || 'auto',
  VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY || 'local-dev-master-key-32-bytes-key!',
  API_TOKEN_TTL_MS: Number(process.env.API_TOKEN_TTL_MS || 24 * 60 * 60 * 1000),
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 120),
  ABUSE_CONTROL_ENABLED: parseBoolWithProductionDefault('ABUSE_CONTROL_ENABLED', true),
  ABUSE_WINDOW_MS: Number(process.env.ABUSE_WINDOW_MS || 300_000),
  ABUSE_BLOCK_DURATION_MS: Number(process.env.ABUSE_BLOCK_DURATION_MS || 180_000),
  ABUSE_SCORE_LIMIT: Number(process.env.ABUSE_SCORE_LIMIT || 24),
  ABUSE_SENDER_SCORE_WEIGHT: Number(process.env.ABUSE_SENDER_SCORE_WEIGHT || 6),
  ABUSE_RECIPIENT_SCORE_WEIGHT: Number(process.env.ABUSE_RECIPIENT_SCORE_WEIGHT || 2),
  ABUSE_IP_SCORE_WEIGHT: Number(process.env.ABUSE_IP_SCORE_WEIGHT || 4),
  ABUSE_DEVICE_SCORE_WEIGHT: Number(process.env.ABUSE_DEVICE_SCORE_WEIGHT || 2),
  ABUSE_DEVICE_MISSING_UA_PENALTY: Number(process.env.ABUSE_DEVICE_MISSING_UA_PENALTY || 2),
  ABUSE_SENDER_MAX_PER_WINDOW: Number(process.env.ABUSE_SENDER_MAX_PER_WINDOW || 12),
  ABUSE_RECIPIENT_MAX_PER_WINDOW: Number(process.env.ABUSE_RECIPIENT_MAX_PER_WINDOW || 80),
  ABUSE_IP_MAX_PER_WINDOW: Number(process.env.ABUSE_IP_MAX_PER_WINDOW || 40),
  ABUSE_DEVICE_MAX_PER_WINDOW: Number(process.env.ABUSE_DEVICE_MAX_PER_WINDOW || 30),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  OTP_DEBUG_RETURN_CODE: parseBool(process.env.OTP_DEBUG_RETURN_CODE, isTest),
  OTP_SMS_PROVIDER: process.env.OTP_SMS_PROVIDER || (isProduction ? 'disabled' : 'console'),
  OTP_EMAIL_PROVIDER: process.env.OTP_EMAIL_PROVIDER || (isProduction ? 'disabled' : 'console'),
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '',
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || '',
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL || '',
  WHATSAPP_WEBHOOK_URL: process.env.WHATSAPP_WEBHOOK_URL || '',
  WHATSAPP_WEBHOOK_TOKEN: process.env.WHATSAPP_WEBHOOK_TOKEN || '',
  WHATSAPP_API_VERSION: process.env.WHATSAPP_API_VERSION || 'v20.0',
  WHATSAPP_API_BASE: process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  WHATSAPP_ACCOUNT_TOKEN: process.env.WHATSAPP_ACCOUNT_TOKEN || process.env.WHATSAPP_WEBHOOK_TOKEN || '',
  X_WEBHOOK_URL: process.env.X_WEBHOOK_URL || '',
  X_WEBHOOK_TOKEN: process.env.X_WEBHOOK_TOKEN || '',
  X_API_BASE: process.env.X_API_BASE || 'https://api.x.com/2',
  X_BEARER_TOKEN: process.env.X_BEARER_TOKEN || process.env.X_WEBHOOK_TOKEN || '',
  NOTIFICATION_PROVIDER_TIMEOUT_MS: Number(process.env.NOTIFICATION_PROVIDER_TIMEOUT_MS || 2000),
  NOTIFICATION_PROVIDERS_STRICT: parseBoolWithProductionDefault('NOTIFICATION_PROVIDERS_STRICT', true),
  SOCIAL_AUTH_SECRET: process.env.SOCIAL_AUTH_SECRET || '',
  SOCIAL_VERIFY_URL: process.env.SOCIAL_VERIFY_URL || '',
  PASSKEY_SOCIAL_NAMESPACE: process.env.PASSKEY_SOCIAL_NAMESPACE || 'mmp',
  PASSKEY_VERIFY_URL: process.env.PASSKEY_VERIFY_URL || '',
  PASSKEY_AUDIENCE: process.env.PASSKEY_AUDIENCE || '',
  SOCIAL_AUDIENCE: process.env.SOCIAL_AUDIENCE || '',
  METRICS_ROUTE_TOKEN: process.env.METRICS_ROUTE_TOKEN || '',
  LEGAL_TOS_VERSION: process.env.LEGAL_TOS_VERSION || 'v1',
  LEGAL_TOS_APPROVED_AT: process.env.LEGAL_TOS_APPROVED_AT || '',
  COMPLIANCE_BLOCK_ON_WARN: parseBool(process.env.COMPLIANCE_BLOCK_ON_WARN),
  COMPLIANCE_ENFORCE_LAUNCH: parseBoolWithProductionDefault('COMPLIANCE_ENFORCE_LAUNCH', true),
  LAUNCH_STARTUP_GATING: parseBoolWithProductionDefault('LAUNCH_STARTUP_GATING', true),
  IDENTITY_VERIFICATION_STRICT: parseBoolWithProductionDefault('IDENTITY_VERIFICATION_STRICT', true),
  IDENTITY_ALLOWED_PROVIDERS: splitCsvValue(process.env.IDENTITY_ALLOWED_PROVIDERS),
  ALERT_PENDING_DELIVERY_JOBS_THRESHOLD: Number(process.env.ALERT_PENDING_DELIVERY_JOBS_THRESHOLD || 200),
  ALERT_FAILED_DELIVERY_JOBS_THRESHOLD: Number(process.env.ALERT_FAILED_DELIVERY_JOBS_THRESHOLD || 50),
  DATABASE_MIGRATIONS_ON_START: process.env.DATABASE_MIGRATIONS_ON_START !== 'false',
  LEGAL_POLICY_DOC_URL: process.env.LEGAL_POLICY_DOC_URL || '',
  CHAIN_START_BLOCK: Number(process.env.CHAIN_START_BLOCK || 0),
  CHAIN_INDEXER_POLL_INTERVAL_MS: Number(process.env.CHAIN_INDEXER_POLL_INTERVAL_MS || 8_000),
  CHAIN_INDEXER_ENABLED: process.env.CHAIN_INDEXER_ENABLED === 'true',
  DELIVERY_WORKER_ENABLED: process.env.DELIVERY_WORKER_ENABLED === 'true',
  DELIVERY_WORKER_POLL_INTERVAL_MS: Number(process.env.DELIVERY_WORKER_POLL_INTERVAL_MS || 5_000),
  DELIVERY_WORKER_BATCH_SIZE: Number(process.env.DELIVERY_WORKER_BATCH_SIZE || 20),
  DELIVERY_WORKER_LOCK_TTL_MS: Number(process.env.DELIVERY_WORKER_LOCK_TTL_MS || 60_000),
  METRICS_ENABLED: parseBoolWithProductionDefault('METRICS_ENABLED', true),
  METRICS_AUTH_TOKEN: process.env.METRICS_AUTH_TOKEN || '',
  METRICS_MAX_SNAPSHOTS: Number(process.env.METRICS_MAX_SNAPSHOTS || 250),
  TRACE_ENABLED: parseBoolWithProductionDefault('TRACE_ENABLED', false),
  TRACE_MAX_SPANS: Number(process.env.TRACE_MAX_SPANS || 250),
  TRACE_EXPORT_URL: process.env.TRACE_EXPORT_URL || '',
  TRACE_BUFFER_FLUSH_MS: Number(process.env.TRACE_BUFFER_FLUSH_MS || 5000),
  OTEL_TRACING_ENABLED: parseBoolWithProductionDefault('OTEL_TRACING_ENABLED', true),
  OTEL_TRACES_EXPORT_URL: process.env.OTEL_TRACES_EXPORT_URL || '',
  OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || 'mmp-api',
  OBSERVABILITY_ALERT_WEBHOOK_URL: process.env.OBSERVABILITY_ALERT_WEBHOOK_URL || '',
  OBSERVABILITY_ALERT_TOKEN: process.env.OBSERVABILITY_ALERT_TOKEN || '',
  OBSERVABILITY_ALERT_WEBHOOK_INTERVAL_MS: Number(
    process.env.OBSERVABILITY_ALERT_WEBHOOK_INTERVAL_MS || 15_000,
  ),
  OBSERVABILITY_ALERT_SEVERITY: (process.env.OBSERVABILITY_ALERT_SEVERITY || 'warning').toLowerCase(),
  ALERT_INDEXER_LAG_BLOCKS_THRESHOLD: Number(process.env.ALERT_INDEXER_LAG_BLOCKS_THRESHOLD || 100),
  ALERT_PENDING_DELIVERY_AGE_MS_THRESHOLD: Number(process.env.ALERT_PENDING_DELIVERY_AGE_MS_THRESHOLD || 15 * 60 * 1000),
  OBSERVABILITY_ALERT_RUNBOOK_URL: process.env.OBSERVABILITY_ALERT_RUNBOOK_URL || '',
  REQUIRE_SOCIAL_TOS_ACCEPTED: process.env.REQUIRE_SOCIAL_TOS_ACCEPTED === 'true',
  PASSKEY_RP_ID: process.env.PASSKEY_RP_ID || 'localhost',
  PASSKEY_RP_NAME: process.env.PASSKEY_RP_NAME || 'MMP',
  PASSKEY_ORIGIN: process.env.PASSKEY_ORIGIN || 'http://localhost:3000',
  HANDLE_ROTATION_COOLDOWN_MS: Number(process.env.HANDLE_ROTATION_COOLDOWN_MS || 7 * 24 * 60 * 60 * 1000),
  CUSTODIAL_WALLET_SIGNING_ENABLED: parseBoolWithProductionDefault('CUSTODIAL_WALLET_SIGNING_ENABLED', true),
  ALLOW_UNSAFE_PRIVATE_KEY_INPUT: parseBoolWithProductionDefault('ALLOW_UNSAFE_PRIVATE_KEY_INPUT', false, true),
  SOCIAL_OAUTH_STATE_TTL_MS: Number(process.env.SOCIAL_OAUTH_STATE_TTL_MS || 10 * 60 * 1000),
  OAUTH_GOOGLE_CLIENT_ID: process.env.OAUTH_GOOGLE_CLIENT_ID || '',
  OAUTH_GOOGLE_CLIENT_SECRET: process.env.OAUTH_GOOGLE_CLIENT_SECRET || '',
  OAUTH_GOOGLE_REDIRECT_URI: process.env.OAUTH_GOOGLE_REDIRECT_URI || '',
  OAUTH_GOOGLE_AUTH_URL: process.env.OAUTH_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  OAUTH_GOOGLE_TOKEN_URL: process.env.OAUTH_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  OAUTH_GOOGLE_USERINFO_URL:
    process.env.OAUTH_GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
  OAUTH_GITHUB_CLIENT_ID: process.env.OAUTH_GITHUB_CLIENT_ID || '',
  OAUTH_GITHUB_CLIENT_SECRET: process.env.OAUTH_GITHUB_CLIENT_SECRET || '',
  OAUTH_GITHUB_REDIRECT_URI: process.env.OAUTH_GITHUB_REDIRECT_URI || '',
  OAUTH_GITHUB_AUTH_URL: process.env.OAUTH_GITHUB_AUTH_URL || 'https://github.com/login/oauth/authorize',
  OAUTH_GITHUB_TOKEN_URL:
    process.env.OAUTH_GITHUB_TOKEN_URL || 'https://github.com/login/oauth/access_token',
  OAUTH_GITHUB_USERINFO_URL: process.env.OAUTH_GITHUB_USERINFO_URL || 'https://api.github.com/user',
};
