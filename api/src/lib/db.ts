import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import {
  closePostgresPool,
  execPostgres,
  isPostgresEnabled,
  queryPostgres,
  withPostgresClient,
} from './postgres';
import {
  assertRedisForDistributedWorkersOrThrow,
  tryAcquireDistributedLock,
  releaseDistributedLock,
} from './redis';
import { incrementCounter } from './metrics';
import { hmacPii, maskEmail, maskPhone, normalizeEmail, normalizePhone } from './pii';

export type Pricing = {
  defaultPrice: number;
  firstContactPrice: number;
};

type DbRow = Record<string, any>;

type ChannelConnectionPayload = {
  externalHandle: string | null;
  secretRef: string | null;
  status: string;
  consentVersion: string | null;
  consentAcceptedAt?: number | null;
};

type IdentityBindingPayload = {
  walletAddress: string;
  method: string;
  provider: string;
  subject: string;
  userId: string;
  linkedAt?: number;
  lastSeenAt?: number;
  revokedAt?: number | null;
};

type StoreShape = {
  users: DbRow[];
  verificationCodes: DbRow[];
  pricingProfiles: DbRow[];
  messages: DbRow[];
  payments: DbRow[];
  channelConnections: DbRow[];
  vaultAuditLog: DbRow[];
  vaultBlobs: DbRow[];
  passkeyCredentials: DbRow[];
  custodialWallets: DbRow[];
  messageIdempotency: DbRow[];
  deliveryJobs: DbRow[];
  chainEvents: DbRow[];
  chainEventCheckpoints: DbRow[];
  identityBindings: DbRow[];
  abuseCounters: DbRow[];
  abuseBlocks: DbRow[];
  abuseEvents: DbRow[];
};

type DeliveryJob = {
  id: string;
  message_id: string;
  user_id: string;
  channel: string;
  destination: string;
  payload_json: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  locked_by: string | null;
  locked_until: number | null;
  error_text: string | null;
  created_at: number;
  updated_at: number;
};

export type DeliveryJobRecord = DeliveryJob;

type SqlDbLike = {
  prepare: (query: string) => {
    run: (...args: any[]) => any;
    get: (...args: any[]) => any;
    all: (...args: any[]) => any;
    allMap?: (...args: any[]) => any;
  };
  pragma: (name: string) => void;
  exec: (query: string) => void;
  close: () => void;
};

type PostgresParamValue = string | number | null | boolean;

const storePath = env.DATABASE_PATH;

function ensureStoreDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let useFallback = false;
let jsonStorePath = storePath;
let fallbackInitialized = false;
let sqliteDb: SqlDbLike | null = null;
let isPostgresBackend = isPostgresEnabled();
let persistenceValidated = false;
let migrationApplied = false;
const AUDIT_FALLBACK_WINDOW = 50;
type AuditDropRecord = {
  at: number;
  userId: string;
  eventType: string;
  reason: string;
};
const auditDropHistory: AuditDropRecord[] = [];
const postgresTestTables = [
  'abuse_counters',
  'abuse_blocks',
  'abuse_events',
  'chain_events',
  'chain_event_checkpoints',
  'custodial_wallets',
  'identity_bindings',
  'delivery_jobs',
  'message_idempotency',
  'messages',
  'passkey_credentials',
  'verification_codes',
  'vault_audit_log',
  'vault_blobs',
  'channel_connections',
  'pricing_profiles',
  'users',
];

function isSourceLikelySqliteLike(filePath: string) {
  return /\.(sqlite|db|sqlite3)$/i.test(filePath);
}

function normalizeWallet(value: string | null | undefined) {
  return (value || '').toLowerCase();
}

function refreshBackendMode() {
  isPostgresBackend = isPostgresEnabled();
}

type PostgresDeliveryRow = {
  id: string;
  message_id: string;
  user_id: string;
  channel: string;
  destination: string;
  payload_json: string;
  status: string;
  attempts: string | number;
  max_attempts: string | number;
  next_attempt_at: string | number;
  locked_by: string | null;
  locked_until: string | number | null;
  error_text: string | null;
  created_at: string | number;
  updated_at: string | number;
};

type PostgresCheckpointRow = {
  chain_key: string;
  last_processed_block: string | number;
  updated_at: string | number;
};

export type IdentityBindingRecord = {
  id: string;
  userId: string;
  method: string;
  provider: string;
  subject: string;
  walletAddress: string;
  linkedAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

type PostgresIdentityBindingRow = {
  id: string;
  user_id: string;
  method: string;
  provider: string;
  subject: string;
  wallet_address: string;
  linked_at: string | number;
  last_seen_at: string | number;
  revoked_at: string | number | null;
};

function withPostgresParams(sql: string, params: PostgresParamValue[] = []) {
  let index = 0;
  const text = sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
  return { text, params };
}

async function pgGet<T>(sql: string, params: PostgresParamValue[] = []) {
  const prepared = withPostgresParams(sql, params);
  const rows = await queryPostgres<T>(prepared.text, prepared.params);
  return rows[0] ?? null;
}

async function pgAll<T>(sql: string, params: PostgresParamValue[] = []) {
  const prepared = withPostgresParams(sql, params);
  return queryPostgres<T>(prepared.text, prepared.params);
}

function deliveryClaimLockKey() {
  return 'mmp:delivery:claim';
}

export function indexerLockKey(chainKey: string) {
  return `mmp:indexer:${chainKey}`;
}

function mapDeliveryJob(row: PostgresDeliveryRow): DeliveryJob {
  return {
    id: row.id,
    message_id: row.message_id,
    user_id: row.user_id,
    channel: row.channel,
    destination: row.destination,
    payload_json: row.payload_json,
    status: row.status,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: Number(row.next_attempt_at),
    locked_by: row.locked_by,
    locked_until: row.locked_until === null ? null : Number(row.locked_until),
    error_text: row.error_text,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function mapIdentityBinding(row: PostgresIdentityBindingRow): IdentityBindingRecord {
  return {
    id: row.id,
    userId: row.user_id,
    method: row.method,
    provider: row.provider,
    subject: row.subject,
    walletAddress: row.wallet_address,
    linkedAt: Number(row.linked_at),
    lastSeenAt: Number(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

function initJsonStore() {
  if (fallbackInitialized) {
    return;
  }

  ensureStoreDir(jsonStorePath);
  if (!fs.existsSync(jsonStorePath)) {
    const initial: StoreShape = {
      users: [],
      verificationCodes: [],
      pricingProfiles: [],
      messages: [],
      payments: [],
      channelConnections: [],
      vaultAuditLog: [],
      vaultBlobs: [],
      passkeyCredentials: [],
      custodialWallets: [],
      messageIdempotency: [],
      deliveryJobs: [],
      chainEvents: [],
      chainEventCheckpoints: [],
      identityBindings: [],
      abuseCounters: [],
      abuseBlocks: [],
      abuseEvents: [],
    };
    fs.writeFileSync(jsonStorePath, JSON.stringify(initial, null, 2));
  }
  fallbackInitialized = true;
}

function readJsonStore(): StoreShape {
  initJsonStore();
  const raw = fs.readFileSync(jsonStorePath, 'utf8');
  const parsed = JSON.parse(raw) as StoreShape;
  return {
    users: parsed.users || [],
    verificationCodes: parsed.verificationCodes || [],
    pricingProfiles: parsed.pricingProfiles || [],
    messages: parsed.messages || [],
    payments: parsed.payments || [],
    channelConnections: parsed.channelConnections || [],
    vaultAuditLog: parsed.vaultAuditLog || [],
    vaultBlobs: (parsed as any).vaultBlobs || [],
    passkeyCredentials: (parsed as any).passkeyCredentials || [],
    custodialWallets: (parsed as any).custodialWallets || [],
    messageIdempotency: parsed.messageIdempotency || [],
    deliveryJobs: parsed.deliveryJobs || [],
    chainEvents: parsed.chainEvents || [],
    chainEventCheckpoints: parsed.chainEventCheckpoints || [],
    identityBindings: parsed.identityBindings || [],
    abuseCounters: parsed.abuseCounters || [],
    abuseBlocks: parsed.abuseBlocks || [],
    abuseEvents: parsed.abuseEvents || [],
  };
}

function writeJsonStore(store: StoreShape) {
  ensureStoreDir(jsonStorePath);
  fs.writeFileSync(jsonStorePath, JSON.stringify(store, null, 2));
}

function withJsonStore<T>(fn: (store: StoreShape) => T): T {
  const store = readJsonStore();
  const result = fn(store);
  writeJsonStore(store);
  return result;
}

function now() {
  return Date.now();
}

function trackAuditDrop(userId: string, eventType: string, reason: string, metadata: Record<string, any>) {
  const nowTs = now();
  auditDropHistory.unshift({
    at: nowTs,
    userId,
    eventType,
    reason,
  });
  if (auditDropHistory.length > AUDIT_FALLBACK_WINDOW) {
    auditDropHistory.length = AUDIT_FALLBACK_WINDOW;
  }
  incrementCounter('mmp_audit_log_drops_total', { reason, event_type: eventType });
  if (env.NODE_ENV === 'test' && metadata?.error) {
    auditDropHistory[0]!.reason = `${reason}:${String(metadata.error).slice(0, 120)}`;
  }
}

function isChannelTermsGated(channel: string) {
  return channel === 'whatsapp' || channel === 'x';
}

function isChannelConsentCurrent(connection: DbRow) {
  if (!isChannelTermsGated(connection.channel)) {
    return true;
  }
  if (!env.REQUIRE_SOCIAL_TOS_ACCEPTED) {
    return true;
  }
  if (connection.consent_version !== env.LEGAL_TOS_VERSION) {
    return false;
  }
  const acceptedAt = Number(connection.consent_accepted_at);
  return Number.isFinite(acceptedAt) && acceptedAt > 0;
}

function mapChannelConnection(row: DbRow) {
  return {
    ...row,
    consent_accepted_at: toNumber(row.consent_accepted_at),
  };
}

function isPostgresUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505';
}

const SQLITE_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '0001_core_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL UNIQUE,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        phone TEXT,
        phone_verified INTEGER NOT NULL DEFAULT 0,
        handle TEXT UNIQUE,
        discoverable_by_handle INTEGER NOT NULL DEFAULT 1,
        discoverable_by_phone INTEGER NOT NULL DEFAULT 0,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS verification_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        target TEXT NOT NULL,
        code TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pricing_profiles (
        user_id TEXT PRIMARY KEY,
        default_price INTEGER NOT NULL DEFAULT 200,
        first_contact_price INTEGER NOT NULL DEFAULT 500,
        return_discount_bps INTEGER NOT NULL DEFAULT 500,
        accepts_all INTEGER NOT NULL DEFAULT 1,
        profile_uri TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        sender_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        price INTEGER NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS channel_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        external_handle TEXT,
        secret_ref TEXT,
        consent_version TEXT,
        consent_accepted_at BIGINT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id, channel),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS vault_audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS message_idempotency (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(sender_id, idempotency_key),
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_verification_codes_lookup
        ON verification_codes(user_id, channel, target, verified, expires_at);
      CREATE INDEX IF NOT EXISTS idx_messages_recipient_created
        ON messages(recipient_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_recipient
        ON messages(sender_id, recipient_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_idempotency_sender_key
        ON message_idempotency(sender_id, idempotency_key);
    `,
  },
  {
    name: '0002_chain_event_checkpoints',
    sql: `
      CREATE TABLE IF NOT EXISTS chain_event_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_key TEXT NOT NULL UNIQUE,
        last_processed_block INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chain_events (
        id TEXT PRIMARY KEY,
        chain_key TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        payer TEXT NOT NULL,
        recipient TEXT NOT NULL,
        amount TEXT NOT NULL,
        fee TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        channel INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(chain_key, tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_chain_events_chain_pending
        ON chain_events(chain_key, block_number DESC);
    `,
  },
  {
    name: '0003_delivery_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS delivery_jobs (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        destination TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at INTEGER NOT NULL,
        locked_by TEXT,
        locked_until INTEGER,
        error_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status_next
        ON delivery_jobs(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_delivery_jobs_locked
        ON delivery_jobs(locked_by, locked_until);
    `,
  },
  {
    name: '0004_schema_migrations',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `,
  },
  {
    name: '0005_delivery_jobs_idempotency',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_jobs_message_channel_destination_unique
        ON delivery_jobs (message_id, channel, destination);
    `,
  },
  {
    name: '0006_identity_bindings',
    sql: `
      CREATE TABLE IF NOT EXISTS identity_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        method TEXT NOT NULL,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE (method, provider, subject),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_bindings_wallet_address
        ON identity_bindings (wallet_address);
      CREATE INDEX IF NOT EXISTS idx_identity_bindings_method_provider_subject
        ON identity_bindings (method, provider, subject);
    `,
  },
  {
    name: '0007_abuse_controls',
    sql: `
      CREATE TABLE IF NOT EXISTS abuse_counters (
        key_type TEXT NOT NULL,
        key_value TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key_type, key_value, window_start)
      );
      CREATE INDEX IF NOT EXISTS idx_abuse_counters_window_start
        ON abuse_counters(window_start);
      CREATE INDEX IF NOT EXISTS idx_abuse_counters_key_type_value
        ON abuse_counters(key_type, key_value);

      CREATE TABLE IF NOT EXISTS abuse_blocks (
        key_type TEXT NOT NULL,
        key_value TEXT NOT NULL,
        blocked_until INTEGER NOT NULL,
        reason TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key_type, key_value)
      );
      CREATE INDEX IF NOT EXISTS idx_abuse_blocks_blocked_until
        ON abuse_blocks(blocked_until);

      CREATE TABLE IF NOT EXISTS abuse_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        decision TEXT NOT NULL,
        score INTEGER NOT NULL,
        sender_id TEXT,
        recipient_id TEXT,
        ip_key TEXT,
        device_key TEXT,
        window_start INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        reason TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_abuse_events_created_at
        ON abuse_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_abuse_events_sender_created_at
        ON abuse_events(sender_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_abuse_events_recipient_created_at
        ON abuse_events(recipient_id, created_at DESC);
    `,
  },
  {
    name: '0008_vault_blobs_and_identity_hardening',
    sql: `
      ALTER TABLE users ADD COLUMN email_hash TEXT;
      ALTER TABLE users ADD COLUMN email_mask TEXT;
      ALTER TABLE users ADD COLUMN phone_hash TEXT;
      ALTER TABLE users ADD COLUMN phone_mask TEXT;
      ALTER TABLE users ADD COLUMN handle_updated_at INTEGER;
      ALTER TABLE users ADD COLUMN basename TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_hash_unique ON users(email_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_hash_unique ON users(phone_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_lower_unique ON users(lower(handle));

      CREATE TABLE IF NOT EXISTS vault_blobs (
        user_id TEXT PRIMARY KEY,
        blob_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `,
  },
  {
    name: '0009_passkeys_and_custodial_wallets',
    sql: `
      CREATE TABLE IF NOT EXISTS custodial_wallets (
        user_id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL UNIQUE,
        encrypted_private_key_json TEXT NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_handle TEXT NOT NULL,
        rp_id TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key_b64 TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id ON passkey_credentials(user_id);
      CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_handle ON passkey_credentials(user_handle);
    `,
  },
];

const POSTGRES_SCHEMA_SQL = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL UNIQUE,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_hash TEXT,
      email_mask TEXT,
      phone TEXT,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      phone_hash TEXT,
      phone_mask TEXT,
      handle TEXT UNIQUE,
      discoverable_by_handle INTEGER NOT NULL DEFAULT 1,
      discoverable_by_phone INTEGER NOT NULL DEFAULT 0,
      handle_updated_at BIGINT,
      basename TEXT,
      balance NUMERIC NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_users_wallet_address ON users (wallet_address);`,
  `CREATE INDEX IF NOT EXISTS idx_users_handle ON users (handle);`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_mask TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_hash TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_mask TEXT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS handle_updated_at BIGINT;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS basename TEXT;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_hash_unique ON users (email_hash) WHERE email_hash IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_hash_unique ON users (phone_hash) WHERE phone_hash IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_lower_unique ON users (LOWER(handle));`,
  `
    CREATE TABLE IF NOT EXISTS verification_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      target TEXT NOT NULL,
      code TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_verification_codes_lookup
    ON verification_codes (user_id, channel, target, verified, expires_at);
  `,
  `
    CREATE TABLE IF NOT EXISTS pricing_profiles (
      user_id TEXT PRIMARY KEY,
      default_price INTEGER NOT NULL DEFAULT 200,
      first_contact_price INTEGER NOT NULL DEFAULT 500,
      return_discount_bps INTEGER NOT NULL DEFAULT 500,
      accepts_all INTEGER NOT NULL DEFAULT 1,
      profile_uri TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_messages_recipient_created ON messages (recipient_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_recipient ON messages (sender_id, recipient_id, created_at DESC);`,
  `
      CREATE TABLE IF NOT EXISTS channel_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        external_handle TEXT,
        secret_ref TEXT,
        consent_version TEXT,
        consent_accepted_at BIGINT,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE (user_id, channel),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
  `,
  `
    CREATE TABLE IF NOT EXISTS vault_audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at BIGINT NOT NULL,
      metadata_json TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS vault_blobs (
      user_id TEXT PRIMARY KEY,
      blob_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS message_idempotency (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE (sender_id, idempotency_key),
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_message_idempotency_sender_key ON message_idempotency (sender_id, idempotency_key);`,
  `
    CREATE TABLE IF NOT EXISTS delivery_jobs (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      destination TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at BIGINT NOT NULL,
      locked_by TEXT,
      locked_until BIGINT,
      error_text TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status_next ON delivery_jobs (status, next_attempt_at);`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_jobs_locked_until ON delivery_jobs (locked_by, locked_until);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_jobs_message_channel_destination_unique
     ON delivery_jobs (message_id, channel, destination);`,
  `
    CREATE TABLE IF NOT EXISTS chain_event_checkpoints (
      chain_key TEXT PRIMARY KEY,
      last_processed_block BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS chain_events (
      id TEXT PRIMARY KEY,
      chain_key TEXT NOT NULL,
      block_number BIGINT NOT NULL,
      block_hash TEXT,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      payer TEXT NOT NULL,
      recipient TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      fee NUMERIC NOT NULL,
      content_hash TEXT NOT NULL,
      nonce BIGINT NOT NULL,
      channel INTEGER NOT NULL,
      observed_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(chain_key, tx_hash, log_index)
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_chain_events_chain_pending
     ON chain_events (chain_key, block_number DESC);`,
  `
    ALTER TABLE channel_connections
      ADD COLUMN IF NOT EXISTS consent_accepted_at BIGINT;
  `,
  `
    ALTER TABLE channel_connections
      ADD COLUMN IF NOT EXISTS updated_at BIGINT;
  `,
  `
    ALTER TABLE channel_connections
      ADD COLUMN IF NOT EXISTS consent_version TEXT;
  `,
  `
    CREATE TABLE IF NOT EXISTS identity_bindings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      method TEXT NOT NULL,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      linked_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      revoked_at BIGINT,
      UNIQUE (method, provider, subject),
      UNIQUE (wallet_address),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_bindings_wallet_address ON identity_bindings (wallet_address);`,
  `CREATE INDEX IF NOT EXISTS idx_identity_bindings_method_provider_subject ON identity_bindings (method, provider, subject);`,
  `
    CREATE TABLE IF NOT EXISTS custodial_wallets (
      user_id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL UNIQUE,
      encrypted_private_key_json TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_custodial_wallets_wallet_address ON custodial_wallets (wallet_address);`,
  `
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_handle TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key_b64 TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_used_at BIGINT,
      revoked_at BIGINT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id ON passkey_credentials (user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_handle ON passkey_credentials (user_handle);`,
  `
    CREATE TABLE IF NOT EXISTS abuse_counters (
      key_type TEXT NOT NULL,
      key_value TEXT NOT NULL,
      window_start BIGINT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (key_type, key_value, window_start)
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_abuse_counters_window_start ON abuse_counters (window_start);`,
  `CREATE INDEX IF NOT EXISTS idx_abuse_counters_key_type_value ON abuse_counters (key_type, key_value);`,
  `
    CREATE TABLE IF NOT EXISTS abuse_blocks (
      key_type TEXT NOT NULL,
      key_value TEXT NOT NULL,
      blocked_until BIGINT NOT NULL,
      reason TEXT NOT NULL,
      metadata_json TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (key_type, key_value)
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_abuse_blocks_blocked_until ON abuse_blocks (blocked_until);`,
  `
    CREATE TABLE IF NOT EXISTS abuse_events (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      decision TEXT NOT NULL,
      score INTEGER NOT NULL,
      sender_id TEXT,
      recipient_id TEXT,
      ip_key TEXT,
      device_key TEXT,
      window_start BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      reason TEXT,
      details_json TEXT
    );
  `,
  `CREATE INDEX IF NOT EXISTS idx_abuse_events_created_at ON abuse_events (created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_abuse_events_sender_created_at ON abuse_events (sender_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_abuse_events_recipient_created_at ON abuse_events (recipient_id, created_at DESC);`,
];

let postgresSchemaInitialized = false;
let postgresSchemaInitPromise: Promise<void> | null = null;
const POSTGRES_SCHEMA_MIGRATION_LOCK_ID = 712_345_678;

async function withPostgresMigrationLock<T>(task: () => Promise<T>) {
  await queryPostgres('SELECT pg_advisory_lock($1)', [POSTGRES_SCHEMA_MIGRATION_LOCK_ID]);
  try {
    return await task();
  } finally {
    await queryPostgres('SELECT pg_advisory_unlock($1)', [POSTGRES_SCHEMA_MIGRATION_LOCK_ID]).catch(() => {});
  }
}

async function ensurePostgresSchema() {
  if (!isPostgresBackend || postgresSchemaInitialized) {
    return;
  }
  if (!postgresSchemaInitPromise) {
    postgresSchemaInitPromise = (async () => {
      await withPostgresMigrationLock(async () => {
        for (const sql of POSTGRES_SCHEMA_SQL) {
          await execPostgres(sql);
        }
        await migrateFromSourceIfConfigured();
        postgresSchemaInitialized = true;
      });
    })().catch((error) => {
      postgresSchemaInitPromise = null;
      throw error;
    });
  }
  await postgresSchemaInitPromise;
}

export async function migratePostgresSchema() {
  await ensurePostgresSchema();
}

function applySqliteMigration(database: SqlDbLike, name: string, sql: string) {
  const applied = (database.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name) as
    | { name: string }
    | undefined) ?? null;
  if (applied) return;
  database.exec(sql);
  database.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, now());
}

function sqliteHasColumn(database: SqlDbLike, table: string, columnName: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((column) => column.name === columnName);
}

function ensureSqliteChannelConnectionColumns(database: SqlDbLike) {
  if (!sqliteHasColumn(database, 'channel_connections', 'consent_accepted_at')) {
    database.exec('ALTER TABLE channel_connections ADD COLUMN consent_accepted_at BIGINT');
  }
  if (!sqliteHasColumn(database, 'channel_connections', 'updated_at')) {
    database.exec('ALTER TABLE channel_connections ADD COLUMN updated_at INTEGER');
  }
  if (!sqliteHasColumn(database, 'channel_connections', 'consent_version')) {
    database.exec('ALTER TABLE channel_connections ADD COLUMN consent_version TEXT');
  }
  database.exec('UPDATE channel_connections SET consent_accepted_at = NULL WHERE consent_version IS NULL');
  database.exec('UPDATE channel_connections SET updated_at = COALESCE(updated_at, created_at) WHERE updated_at IS NULL');
}

function mapJsonRow<T = DbRow>(row: DbRow | undefined): T | null {
  if (!row) return null;
  return row as T;
}

function toNullableString(value: any) {
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
}

function toNumber(value: any): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function upsertPostgresRows(
  tableName: string,
  columns: string[],
  rows: Array<Record<string, any>>,
  conflictTarget: string,
) {
  if (!rows.length) return;

  const updateColumns = columns.filter((column) => column !== 'id');
  const updateSet = updateColumns.length ? updateColumns.map((column) => `${column}=EXCLUDED.${column}`).join(', ') : 'id = EXCLUDED.id';

  for (const row of rows) {
    const values = columns.map((column) => {
      const value = row[column];
      if (value === undefined) return null;
      return value;
    });

    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    const insertSql = `
      INSERT INTO ${tableName} (${columns.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (${conflictTarget}) DO UPDATE SET
        ${updateSet}
    `;

    await queryPostgres(insertSql, values);
  }
}

async function migrateFromJsonSource(sourcePath: string) {
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const payload = JSON.parse(raw) as StoreShape;
  const source = {
    users: (payload.users || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    verificationCodes: (payload.verificationCodes || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    pricingProfiles: (payload.pricingProfiles || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    messages: (payload.messages || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    payments: (payload.payments || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    channelConnections: (payload.channelConnections || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    vaultAuditLog: (payload.vaultAuditLog || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    vaultBlobs: ((payload as any).vaultBlobs || []).map((item: any) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    messageIdempotency: (payload.messageIdempotency || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    deliveryJobs: (payload.deliveryJobs || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    chainEvents: (payload.chainEvents || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    chainEventCheckpoints: (payload.chainEventCheckpoints || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    identityBindings: (payload.identityBindings || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    abuseCounters: (payload.abuseCounters || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    abuseBlocks: (payload.abuseBlocks || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
    abuseEvents: (payload.abuseEvents || []).map((item) => mapJsonRow(item)).filter(Boolean) as DbRow[],
  };

  await upsertPostgresRows(
    'users',
    ['id', 'wallet_address', 'email', 'email_verified', 'email_hash', 'email_mask', 'phone', 'phone_verified', 'phone_hash', 'phone_mask', 'handle', 'handle_updated_at', 'basename', 'discoverable_by_handle', 'discoverable_by_phone', 'balance', 'created_at', 'updated_at'],
    source.users.map((row) => ({
      id: row.id,
      wallet_address: normalizeWallet(row.wallet_address),
      email: null,
      email_verified: toNumber(row.email_verified) ?? 0,
      email_hash:
        row.email_hash ??
        (row.email ? hmacPii(normalizeEmail(String(row.email)), 'user:email') : null),
      email_mask: row.email_mask ?? (row.email ? maskEmail(String(row.email)) : null),
      phone: null,
      phone_verified: toNumber(row.phone_verified) ?? 0,
      phone_hash:
        row.phone_hash ??
        (row.phone ? hmacPii(normalizePhone(String(row.phone)), 'user:phone') : null),
      phone_mask: row.phone_mask ?? (row.phone ? maskPhone(String(row.phone)) : null),
      handle: row.handle ? String(row.handle).toLowerCase() : null,
      handle_updated_at: toNumber(row.handle_updated_at),
      basename: row.basename ?? null,
      discoverable_by_handle: toNumber(row.discoverable_by_handle) ?? 1,
      discoverable_by_phone: toNumber(row.discoverable_by_phone) ?? 0,
      balance: toNumber(row.balance) ?? 0,
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    })),
    'id',
  );

  await upsertPostgresRows(
    'verification_codes',
    ['id', 'user_id', 'channel', 'target', 'code', 'verified', 'expires_at', 'created_at'],
    source.verificationCodes.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      channel: row.channel,
      target: (() => {
        const rawTarget = String(row.target || '');
        if (/^[0-9a-f]{64}$/i.test(rawTarget)) {
          return rawTarget;
        }
        const channel = String(row.channel || '');
        const normalized =
          channel === 'email'
            ? normalizeEmail(rawTarget)
            : channel === 'phone'
              ? normalizePhone(rawTarget)
              : rawTarget.trim();
        return hmacPii(normalized, `verify:${channel || 'unknown'}`);
      })(),
      code: row.code,
      verified: toNumber(row.verified) ?? 0,
      expires_at: toNumber(row.expires_at) ?? 0,
      created_at: toNumber(row.created_at) ?? now(),
    })),
    'id',
  );

  await upsertPostgresRows(
    'pricing_profiles',
    ['user_id', 'default_price', 'first_contact_price', 'return_discount_bps', 'accepts_all', 'profile_uri'],
    source.pricingProfiles.map((row) => ({
      user_id: row.user_id,
      default_price: toNumber(row.default_price) ?? 200,
      first_contact_price: toNumber(row.first_contact_price) ?? 500,
      return_discount_bps: toNumber(row.return_discount_bps) ?? 500,
      accepts_all: toNumber(row.accepts_all) ?? 1,
      profile_uri: row.profile_uri ?? null,
    })),
    'user_id',
  );

  await upsertPostgresRows(
    'messages',
    ['id', 'message_id', 'sender_id', 'recipient_id', 'ciphertext', 'content_hash', 'price', 'status', 'tx_hash', 'created_at'],
    source.messages.map((row) => ({
      id: row.id,
      message_id: row.message_id,
      sender_id: row.sender_id,
      recipient_id: row.recipient_id,
      ciphertext: row.ciphertext,
      content_hash: row.content_hash,
      price: toNumber(row.price) ?? 0,
      status: row.status,
      tx_hash: row.tx_hash ?? null,
      created_at: toNumber(row.created_at) ?? now(),
    })),
    'message_id',
  );

  await upsertPostgresRows(
    'channel_connections',
    ['id', 'user_id', 'channel', 'external_handle', 'secret_ref', 'consent_version', 'consent_accepted_at', 'status', 'created_at', 'updated_at'],
    source.channelConnections.map((row) => ({
      id: row.id || randomUUID(),
      user_id: row.user_id,
      channel: row.channel,
      external_handle: toNullableString(row.external_handle),
      secret_ref: toNullableString(row.secret_ref),
      consent_version: toNullableString(row.consent_version),
      consent_accepted_at: toNumber(row.consent_accepted_at),
      status: row.status,
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    })),
    'id',
  );

  await upsertPostgresRows(
    'vault_audit_log',
    ['id', 'user_id', 'event_type', 'event_at', 'metadata_json'],
    source.vaultAuditLog.map((row) => ({
      id: row.id || randomUUID(),
      user_id: row.user_id,
      event_type: row.event_type,
      event_at: toNumber(row.event_at) ?? now(),
      metadata_json: toNullableString(row.metadata_json),
    })),
    'id',
  );

  await upsertPostgresRows(
    'vault_blobs',
    ['user_id', 'blob_json', 'version', 'created_at', 'updated_at'],
    source.vaultBlobs.map((row) => ({
      user_id: row.user_id,
      blob_json: toNullableString(row.blob_json) ?? toNullableString(row.blobJson) ?? '{}',
      version: toNumber(row.version) ?? 1,
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    })),
    'user_id',
  );

  await upsertPostgresRows(
    'message_idempotency',
    ['id', 'sender_id', 'idempotency_key', 'message_id', 'created_at'],
    source.messageIdempotency.map((row) => ({
      id: row.id || randomUUID(),
      sender_id: row.sender_id,
      idempotency_key: row.idempotency_key,
      message_id: row.message_id,
      created_at: toNumber(row.created_at) ?? now(),
    })),
    'id',
  );

  await upsertPostgresRows(
    'delivery_jobs',
    ['id', 'message_id', 'user_id', 'channel', 'destination', 'payload_json', 'status', 'attempts', 'max_attempts', 'next_attempt_at', 'locked_by', 'locked_until', 'error_text', 'created_at', 'updated_at'],
    source.deliveryJobs.map((row) => ({
      id: row.id,
      message_id: row.message_id,
      user_id: row.user_id,
      channel: row.channel,
      destination: row.destination,
      payload_json: row.payload_json,
      status: row.status,
      attempts: toNumber(row.attempts) ?? 0,
      max_attempts: toNumber(row.max_attempts) ?? 5,
      next_attempt_at: toNumber(row.next_attempt_at) ?? now(),
      locked_by: toNullableString(row.locked_by),
      locked_until: toNumber(row.locked_until),
      error_text: toNullableString(row.error_text),
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    })),
    'id',
  );

  await upsertPostgresRows(
    'chain_events',
    ['id', 'chain_key', 'block_number', 'block_hash', 'tx_hash', 'log_index', 'message_id', 'payer', 'recipient', 'amount', 'fee', 'content_hash', 'nonce', 'channel', 'observed_at', 'created_at'],
    source.chainEvents.map((row) => ({
      id: row.id,
      chain_key: row.chain_key,
      block_number: toNumber(row.block_number) ?? 0,
      block_hash: toNullableString(row.block_hash),
      tx_hash: row.tx_hash,
      log_index: toNumber(row.log_index) ?? 0,
      message_id: row.message_id,
      payer: normalizeWallet(row.payer),
      recipient: normalizeWallet(row.recipient),
      amount: toNullableString(row.amount),
      fee: toNullableString(row.fee),
      content_hash: row.content_hash,
      nonce: toNumber(row.nonce) ?? 0,
      channel: toNumber(row.channel) ?? 0,
      observed_at: toNumber(row.observed_at) ?? now(),
      created_at: toNumber(row.created_at) ?? now(),
    })),
    'chain_key, tx_hash, log_index',
  );

  await upsertPostgresRows(
    'chain_event_checkpoints',
    ['chain_key', 'last_processed_block', 'updated_at'],
    source.chainEventCheckpoints.map((row) => ({
      chain_key: row.chain_key,
      last_processed_block: toNumber(row.last_processed_block) ?? 0,
      updated_at: toNumber(row.updated_at) ?? now(),
    })),
    'chain_key',
  );

  await upsertPostgresRows(
    'identity_bindings',
    ['id', 'user_id', 'method', 'provider', 'subject', 'wallet_address', 'linked_at', 'last_seen_at', 'revoked_at'],
    source.identityBindings.map((row) => ({
      id: row.id || randomUUID(),
      user_id: row.user_id,
      method: row.method,
      provider: row.provider,
      subject: row.subject,
      wallet_address: normalizeWallet(row.wallet_address),
      linked_at: toNumber(row.linked_at) ?? now(),
      last_seen_at: toNumber(row.last_seen_at) ?? now(),
      revoked_at: toNumber(row.revoked_at),
    })),
    'wallet_address',
  );

  await upsertPostgresRows(
    'abuse_counters',
    ['key_type', 'key_value', 'window_start', 'count', 'created_at', 'updated_at'],
    source.abuseCounters.map((row) => ({
      key_type: row.key_type,
      key_value: row.key_value,
      window_start: toNumber(row.window_start) ?? 0,
      count: toNumber(row.count) ?? 0,
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    })),
    'key_type, key_value, window_start',
  );

  await upsertPostgresRows(
    'abuse_blocks',
    ['key_type', 'key_value', 'blocked_until', 'reason', 'metadata_json', 'created_at', 'updated_at'],
    source.abuseBlocks.map((row) => ({
      key_type: row.key_type,
      key_value: row.key_value,
      blocked_until: toNumber(row.blocked_until) ?? 0,
      reason: row.reason ?? 'unknown',
      metadata_json: toNullableString(row.metadata_json),
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    })),
    'key_type, key_value',
  );

  await upsertPostgresRows(
    'abuse_events',
    ['id', 'action', 'decision', 'score', 'sender_id', 'recipient_id', 'ip_key', 'device_key', 'window_start', 'created_at', 'reason', 'details_json'],
    source.abuseEvents.map((row) => ({
      id: row.id || randomUUID(),
      action: row.action,
      decision: row.decision,
      score: toNumber(row.score) ?? 0,
      sender_id: toNullableString(row.sender_id),
      recipient_id: toNullableString(row.recipient_id),
      ip_key: toNullableString(row.ip_key),
      device_key: toNullableString(row.device_key),
      window_start: toNumber(row.window_start) ?? 0,
      created_at: toNumber(row.created_at) ?? now(),
      reason: toNullableString(row.reason),
      details_json: toNullableString(row.details_json),
    })),
    'id',
  );
}

async function migrateFromSqliteSource(sourcePath: string) {
  const sql = require('better-sqlite3');
  const sourceDb = new sql(sourcePath) as SqlDbLike;
  try {
    const fetchAll = (name: string) => {
      try {
        return sourceDb.prepare(`SELECT * FROM ${name}`).all() as DbRow[];
      } catch {
        return [] as DbRow[];
      }
    };

    const users = fetchAll('users').map((row) => ({
      id: row.id,
      wallet_address: normalizeWallet(row.wallet_address),
      email: null,
      email_verified: toNumber(row.email_verified) ?? 0,
      email_hash:
        row.email_hash ??
        (row.email ? hmacPii(normalizeEmail(String(row.email)), 'user:email') : null),
      email_mask: row.email_mask ?? (row.email ? maskEmail(String(row.email)) : null),
      phone: null,
      phone_verified: toNumber(row.phone_verified) ?? 0,
      phone_hash:
        row.phone_hash ??
        (row.phone ? hmacPii(normalizePhone(String(row.phone)), 'user:phone') : null),
      phone_mask: row.phone_mask ?? (row.phone ? maskPhone(String(row.phone)) : null),
      handle: row.handle ? String(row.handle).toLowerCase() : null,
      handle_updated_at: toNumber(row.handle_updated_at),
      basename: row.basename ?? null,
      discoverable_by_handle: toNumber(row.discoverable_by_handle) ?? 1,
      discoverable_by_phone: toNumber(row.discoverable_by_phone) ?? 0,
      balance: toNumber(row.balance) ?? 0,
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    }));
    await upsertPostgresRows('users', ['id', 'wallet_address', 'email', 'email_verified', 'email_hash', 'email_mask', 'phone', 'phone_verified', 'phone_hash', 'phone_mask', 'handle', 'handle_updated_at', 'basename', 'discoverable_by_handle', 'discoverable_by_phone', 'balance', 'created_at', 'updated_at'], users, 'id');

    const pricingProfiles = fetchAll('pricing_profiles').map((row) => ({
      user_id: row.user_id,
      default_price: toNumber(row.default_price) ?? 200,
      first_contact_price: toNumber(row.first_contact_price) ?? 500,
      return_discount_bps: toNumber(row.return_discount_bps) ?? 500,
      accepts_all: toNumber(row.accepts_all) ?? 1,
      profile_uri: row.profile_uri ?? null,
    }));
    await upsertPostgresRows('pricing_profiles', ['user_id', 'default_price', 'first_contact_price', 'return_discount_bps', 'accepts_all', 'profile_uri'], pricingProfiles, 'user_id');

    const messages = fetchAll('messages').map((row) => ({
      id: row.id,
      message_id: row.message_id,
      sender_id: row.sender_id,
      recipient_id: row.recipient_id,
      ciphertext: row.ciphertext,
      content_hash: row.content_hash,
      price: toNumber(row.price) ?? 0,
      status: row.status,
      tx_hash: row.tx_hash ?? null,
      created_at: toNumber(row.created_at) ?? now(),
    }));
    await upsertPostgresRows('messages', ['id', 'message_id', 'sender_id', 'recipient_id', 'ciphertext', 'content_hash', 'price', 'status', 'tx_hash', 'created_at'], messages, 'message_id');

    const verificationCodes = fetchAll('verification_codes').map((row) => ({
      id: row.id,
      user_id: row.user_id,
      channel: row.channel,
      target: (() => {
        const rawTarget = String(row.target || '');
        if (/^[0-9a-f]{64}$/i.test(rawTarget)) {
          return rawTarget;
        }
        const channel = String(row.channel || '');
        const normalized =
          channel === 'email'
            ? normalizeEmail(rawTarget)
            : channel === 'phone'
              ? normalizePhone(rawTarget)
              : rawTarget.trim();
        return hmacPii(normalized, `verify:${channel || 'unknown'}`);
      })(),
      code: row.code,
      verified: toNumber(row.verified) ?? 0,
      expires_at: toNumber(row.expires_at) ?? 0,
      created_at: toNumber(row.created_at) ?? now(),
    }));
    await upsertPostgresRows('verification_codes', ['id', 'user_id', 'channel', 'target', 'code', 'verified', 'expires_at', 'created_at'], verificationCodes, 'id');

    const channelConnections = fetchAll('channel_connections').map((row) => ({
      id: row.id || randomUUID(),
      user_id: row.user_id,
      channel: row.channel,
      external_handle: toNullableString(row.external_handle),
      secret_ref: toNullableString(row.secret_ref),
      consent_version: toNullableString(row.consent_version),
      consent_accepted_at: toNumber(row.consent_accepted_at),
      status: row.status,
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    }));
    await upsertPostgresRows(
      'channel_connections',
      ['id', 'user_id', 'channel', 'external_handle', 'secret_ref', 'consent_version', 'consent_accepted_at', 'status', 'created_at', 'updated_at'],
      channelConnections,
      'id',
    );

    const auditRows = fetchAll('vault_audit_log').map((row) => ({
      id: row.id,
      user_id: row.user_id,
      event_type: row.event_type,
      event_at: toNumber(row.event_at) ?? now(),
      metadata_json: toNullableString(row.metadata_json),
    }));
    await upsertPostgresRows('vault_audit_log', ['id', 'user_id', 'event_type', 'event_at', 'metadata_json'], auditRows, 'id');

    const vaultBlobs = fetchAll('vault_blobs').map((row) => ({
      user_id: row.user_id,
      blob_json: toNullableString(row.blob_json) ?? '{}',
      version: toNumber(row.version) ?? 1,
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    }));
    await upsertPostgresRows('vault_blobs', ['user_id', 'blob_json', 'version', 'created_at', 'updated_at'], vaultBlobs, 'user_id');

    const idempotencyRows = fetchAll('message_idempotency').map((row) => ({
      id: row.id || randomUUID(),
      sender_id: row.sender_id,
      idempotency_key: row.idempotency_key,
      message_id: row.message_id,
      created_at: toNumber(row.created_at) ?? now(),
    }));
    await upsertPostgresRows('message_idempotency', ['id', 'sender_id', 'idempotency_key', 'message_id', 'created_at'], idempotencyRows, 'id');

    const deliveryRows = fetchAll('delivery_jobs').map((row) => ({
      id: row.id,
      message_id: row.message_id,
      user_id: row.user_id,
      channel: row.channel,
      destination: row.destination,
      payload_json: row.payload_json,
      status: row.status,
      attempts: toNumber(row.attempts) ?? 0,
      max_attempts: toNumber(row.max_attempts) ?? 5,
      next_attempt_at: toNumber(row.next_attempt_at) ?? now(),
      locked_by: toNullableString(row.locked_by),
      locked_until: toNumber(row.locked_until),
      error_text: toNullableString(row.error_text),
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    }));
    await upsertPostgresRows(
      'delivery_jobs',
      ['id', 'message_id', 'user_id', 'channel', 'destination', 'payload_json', 'status', 'attempts', 'max_attempts', 'next_attempt_at', 'locked_by', 'locked_until', 'error_text', 'created_at', 'updated_at'],
      deliveryRows,
      'id',
    );

    const chainEvents = fetchAll('chain_events').map((row) => ({
      id: row.id,
      chain_key: row.chain_key,
      block_number: toNumber(row.block_number) ?? 0,
      block_hash: toNullableString(row.block_hash),
      tx_hash: row.tx_hash,
      log_index: toNumber(row.log_index) ?? 0,
      message_id: row.message_id,
      payer: normalizeWallet(row.payer),
      recipient: normalizeWallet(row.recipient),
      amount: toNullableString(row.amount),
      fee: toNullableString(row.fee),
      content_hash: row.content_hash,
      nonce: toNumber(row.nonce) ?? 0,
      channel: toNumber(row.channel) ?? 0,
      observed_at: toNumber(row.observed_at) ?? now(),
      created_at: toNumber(row.created_at) ?? now(),
    }));
    await upsertPostgresRows(
      'chain_events',
      ['id', 'chain_key', 'block_number', 'block_hash', 'tx_hash', 'log_index', 'message_id', 'payer', 'recipient', 'amount', 'fee', 'content_hash', 'nonce', 'channel', 'observed_at', 'created_at'],
      chainEvents,
      'chain_key, tx_hash, log_index',
    );

    const checkpoints = fetchAll('chain_event_checkpoints').map((row) => ({
      chain_key: row.chain_key,
      last_processed_block: toNumber(row.last_processed_block) ?? 0,
      updated_at: toNumber(row.updated_at) ?? now(),
    }));
    await upsertPostgresRows('chain_event_checkpoints', ['chain_key', 'last_processed_block', 'updated_at'], checkpoints, 'chain_key');

    const identityRows = fetchAll('identity_bindings').map((row) => ({
      id: row.id || randomUUID(),
      user_id: row.user_id,
      method: row.method,
      provider: row.provider,
      subject: row.subject,
      wallet_address: normalizeWallet(row.wallet_address),
      linked_at: toNumber(row.linked_at) ?? now(),
      last_seen_at: toNumber(row.last_seen_at) ?? now(),
      revoked_at: toNumber(row.revoked_at),
    }));
    await upsertPostgresRows('identity_bindings', ['id', 'user_id', 'method', 'provider', 'subject', 'wallet_address', 'linked_at', 'last_seen_at', 'revoked_at'], identityRows, 'wallet_address');

    const abuseCounters = fetchAll('abuse_counters').map((row) => ({
      key_type: row.key_type,
      key_value: row.key_value,
      window_start: toNumber(row.window_start) ?? 0,
      count: toNumber(row.count) ?? 0,
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    }));
    await upsertPostgresRows(
      'abuse_counters',
      ['key_type', 'key_value', 'window_start', 'count', 'created_at', 'updated_at'],
      abuseCounters,
      'key_type, key_value, window_start',
    );

    const abuseBlocks = fetchAll('abuse_blocks').map((row) => ({
      key_type: row.key_type,
      key_value: row.key_value,
      blocked_until: toNumber(row.blocked_until) ?? 0,
      reason: row.reason ?? 'unknown',
      metadata_json: toNullableString(row.metadata_json),
      created_at: toNumber(row.created_at) ?? now(),
      updated_at: toNumber(row.updated_at) ?? now(),
    }));
    await upsertPostgresRows(
      'abuse_blocks',
      ['key_type', 'key_value', 'blocked_until', 'reason', 'metadata_json', 'created_at', 'updated_at'],
      abuseBlocks,
      'key_type, key_value',
    );

    const abuseEvents = fetchAll('abuse_events').map((row) => ({
      id: row.id || randomUUID(),
      action: row.action,
      decision: row.decision,
      score: toNumber(row.score) ?? 0,
      sender_id: toNullableString(row.sender_id),
      recipient_id: toNullableString(row.recipient_id),
      ip_key: toNullableString(row.ip_key),
      device_key: toNullableString(row.device_key),
      window_start: toNumber(row.window_start) ?? 0,
      created_at: toNumber(row.created_at) ?? now(),
      reason: toNullableString(row.reason),
      details_json: toNullableString(row.details_json),
    }));
    await upsertPostgresRows(
      'abuse_events',
      ['id', 'action', 'decision', 'score', 'sender_id', 'recipient_id', 'ip_key', 'device_key', 'window_start', 'created_at', 'reason', 'details_json'],
      abuseEvents,
      'id',
    );
  } finally {
    sourceDb.close();
  }
}

async function migrateFromSourceIfConfigured() {
  if (migrationApplied || !env.DATABASE_MIGRATION_SOURCE) {
    return;
  }

  const sourcePath = path.resolve(env.DATABASE_MIGRATION_SOURCE);
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  try {
    if (isSourceLikelySqliteLike(sourcePath)) {
      await migrateFromSqliteSource(sourcePath);
    } else {
      await migrateFromJsonSource(sourcePath);
    }
  } finally {
    migrationApplied = true;
  }
}

function assertPersistenceMode() {
  if (persistenceValidated) {
    return;
  }
  if (!env.PERSISTENCE_STRICT_MODE) {
    return;
  }

  const errors: string[] = [];
  if (env.DATABASE_BACKEND !== 'postgres') {
    errors.push('DATABASE_BACKEND must be postgres');
  }
  if (!env.DATABASE_URL) {
    errors.push('DATABASE_URL must be set');
  }
  if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
    errors.push('REDIS_URL is required in production when PERSISTENCE_STRICT_MODE is enabled');
  }
  if (env.WORKER_DISTRIBUTED && !env.REDIS_URL) {
    errors.push('REDIS_URL is required when WORKER_DISTRIBUTED is true');
  }

  persistenceValidated = true;
  if (errors.length > 0) {
    throw new Error(`persistence strict mode violation: ${errors.join(', ')}`);
  }
}

function createSqliteClient() {
  const sql = require('better-sqlite3');
  const database = new sql(storePath) as SqlDbLike;
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);');
  SQLITE_MIGRATIONS.forEach((migration) => {
    applySqliteMigration(database, migration.name, migration.sql);
  });
  ensureSqliteChannelConnectionColumns(database);

  return database;
}

function initBackend() {
  refreshBackendMode();
  assertPersistenceMode();

  if (sqliteDb || useFallback) {
    if (isPostgresBackend) {
      if (sqliteDb) {
        sqliteDb.close();
        sqliteDb = null;
      }
      useFallback = false;
    }
    return;
  }

  assertPersistenceMode();

  if (isPostgresBackend) {
    return;
  }

  if (!env.ENABLE_SQLITE || env.ENABLE_SQLITE.toLowerCase() === 'false') {
    useFallback = true;
    initJsonStore();
    return;
  }

  try {
    ensureStoreDir(storePath);
    sqliteDb = createSqliteClient();
  } catch (err) {
    useFallback = true;
    initJsonStore();
  }
}

export async function resetStore() {
  persistenceValidated = false;
  migrationApplied = false;
  if (isPostgresBackend) {
    await closePostgresPool();
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }

  if (useFallback && fs.existsSync(jsonStorePath)) {
    fs.unlinkSync(jsonStorePath);
    fallbackInitialized = false;
  } else if (!useFallback) {
    const p = storePath;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  }

  useFallback = false;
  initBackend();

  if (isPostgresBackend && env.NODE_ENV === 'test') {
    await ensurePostgresSchema();
    await execPostgres(`TRUNCATE ${postgresTestTables.join(', ')} RESTART IDENTITY CASCADE`);
  }
}

export async function createUser(walletAddress: string): Promise<DbRow> {
  initBackend();

  if (useFallback) {
    return withJsonStore((store) => {
      const id = randomUUID();
      const ts = now();
      const user = {
        id,
        wallet_address: walletAddress,
        email: null,
        email_verified: 0,
        email_hash: null,
        email_mask: null,
        phone: null,
        phone_verified: 0,
        phone_hash: null,
        phone_mask: null,
        handle: null,
        handle_updated_at: null,
        basename: null,
        discoverable_by_handle: 1,
        discoverable_by_phone: 0,
        balance: 0,
        created_at: ts,
        updated_at: ts,
      };
      store.users.push(user);
      store.pricingProfiles.push({
        user_id: id,
        default_price: 200,
        first_contact_price: 500,
        return_discount_bps: 500,
        accepts_all: 1,
        profile_uri: null,
      });
      return user;
    });
  }

  if (isPostgresBackend) {
    const ts = now();
    const id = randomUUID();
    const normalizedAddress = walletAddress.toLowerCase();
    await withPostgresClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `
            INSERT INTO users (id, wallet_address, email, email_verified, phone, phone_verified, handle, discoverable_by_handle, discoverable_by_phone, balance, created_at, updated_at)
            VALUES ($1, $2, NULL, 0, NULL, 0, NULL, 1, 0, 0, $3, $4)
          `,
          [id, normalizedAddress, ts, ts],
        );
        await client.query(
          `
            INSERT INTO pricing_profiles (user_id, default_price, first_contact_price, return_discount_bps, accepts_all, profile_uri)
            VALUES ($1, 200, 500, 500, 1, NULL)
          `,
          [id],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    return {
      id,
      wallet_address: normalizedAddress,
      email: null,
      email_verified: 0,
      phone: null,
      phone_verified: 0,
      handle: null,
      discoverable_by_handle: 1,
      discoverable_by_phone: 0,
      balance: 0,
      created_at: ts,
      updated_at: ts,
    };
  }

  const ts = now();
  const id = randomUUID();
  const database = sqliteDb as SqlDbLike;
  database.prepare(
    'INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, walletAddress.toLowerCase(), ts, ts);
  database.prepare(
    'INSERT INTO pricing_profiles (user_id, default_price, first_contact_price, return_discount_bps, accepts_all) VALUES (?, 200, 500, 500, 1)',
  ).run(id);
  return database.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export async function findUserByWallet(walletAddress: string): Promise<any> {
  initBackend();
  if (useFallback) {
    return readJsonStore().users.find((u) => u.wallet_address === walletAddress) ?? null;
  }
  if (isPostgresBackend) {
    const row = await pgGet<any>('SELECT * FROM users WHERE wallet_address = ?', [walletAddress.toLowerCase()]);
    return row ?? null;
  }
  return (sqliteDb as SqlDbLike)
    .prepare('SELECT * FROM users WHERE wallet_address = ?')
    .get(walletAddress.toLowerCase()) ?? null;
}

export async function findUserByHandle(handle: string, requireDiscoverable = false): Promise<any> {
  initBackend();
  const normalized = handle.trim().replace(/^@/, '').toLowerCase();
  if (useFallback) {
    const user = readJsonStore().users.find((u) => String(u.handle || '').toLowerCase() === normalized);
    if (!user) return null;
    if (requireDiscoverable && user.discoverable_by_handle !== 1) return null;
    return user;
  }

  if (isPostgresBackend) {
    const row = await pgGet<any>(
      requireDiscoverable
        ? 'SELECT * FROM users WHERE handle = ? AND discoverable_by_handle = 1'
        : 'SELECT * FROM users WHERE handle = ?',
      [normalized],
    );
    return row ?? null;
  }

  return (
    (sqliteDb as SqlDbLike)
      .prepare(
        requireDiscoverable
          ? 'SELECT * FROM users WHERE handle = ? AND discoverable_by_handle = 1'
          : 'SELECT * FROM users WHERE handle = ?',
      )
      .get(normalized) ?? null
      );
}

export async function findUserByPhone(phone: string, requireDiscoverable = false): Promise<any> {
  initBackend();
  const normalizedPhone = normalizePhone(phone);
  const phoneHash = hmacPii(normalizedPhone, 'user:phone');
  if (useFallback) {
    const user = readJsonStore().users.find((u) => u.phone_hash === phoneHash);
    if (!user) return null;
    if (requireDiscoverable && user.discoverable_by_phone !== 1) return null;
    return user;
  }

  if (isPostgresBackend) {
    const row = await pgGet<any>(
      requireDiscoverable
        ? 'SELECT * FROM users WHERE phone_hash = ? AND discoverable_by_phone = 1'
        : 'SELECT * FROM users WHERE phone_hash = ?',
      [phoneHash],
    );
    return row ?? null;
  }

  return (
    (sqliteDb as SqlDbLike)
      .prepare(
        requireDiscoverable
          ? 'SELECT * FROM users WHERE phone_hash = ? AND discoverable_by_phone = 1'
          : 'SELECT * FROM users WHERE phone_hash = ?',
      )
      .get(phoneHash) ?? null
  );
}

export async function getUserById(userId: string): Promise<any> {
  initBackend();
  if (useFallback) {
    return readJsonStore().users.find((u) => u.id === userId) ?? null;
  }

  if (isPostgresBackend) {
    const row = await pgGet<any>('SELECT * FROM users WHERE id = ?', [userId]);
    return row ?? null;
  }

  return (sqliteDb as SqlDbLike).prepare('SELECT * FROM users WHERE id = ?').get(userId) ?? null;
}

export async function updateUser(user: {
  id: string;
  email?: string | null;
  phone?: string | null;
  handle?: string | null;
  basename?: string | null;
  discoverableByHandle?: number;
  discoverableByPhone?: number;
  emailVerified?: number;
  phoneVerified?: number;
  balance?: number;
  handleUpdatedAt?: number | null;
}): Promise<any> {
  initBackend();

  const normalizedEmail =
    typeof user.email === 'undefined'
      ? undefined
      : user.email === null || user.email === ''
        ? null
        : normalizeEmail(user.email);
  const emailHash =
    typeof normalizedEmail === 'undefined'
      ? undefined
      : normalizedEmail === null
        ? null
        : hmacPii(normalizedEmail, 'user:email');
  const emailMask =
    typeof normalizedEmail === 'undefined'
      ? undefined
      : normalizedEmail === null
        ? null
        : maskEmail(normalizedEmail);

  const normalizedPhone =
    typeof user.phone === 'undefined'
      ? undefined
      : user.phone === null || user.phone === ''
        ? null
        : normalizePhone(user.phone);
  const phoneHash =
    typeof normalizedPhone === 'undefined'
      ? undefined
      : normalizedPhone === null
        ? null
        : hmacPii(normalizedPhone, 'user:phone');
  const phoneMask =
    typeof normalizedPhone === 'undefined'
      ? undefined
      : normalizedPhone === null
        ? null
        : maskPhone(normalizedPhone);

  const normalizedHandle =
    typeof user.handle === 'undefined'
      ? undefined
      : user.handle === null || user.handle === ''
        ? null
        : user.handle.trim().replace(/^@/, '').toLowerCase();

  if (useFallback) {
    return withJsonStore((store) => {
      const index = store.users.findIndex((u) => u.id === user.id);
      if (index === -1) return null;
      const current = store.users[index];
      store.users[index] = {
        ...current,
        email: typeof normalizedEmail === 'undefined' ? current.email : null,
        email_hash: typeof emailHash === 'undefined' ? (current as any).email_hash ?? null : emailHash,
        email_mask: typeof emailMask === 'undefined' ? (current as any).email_mask ?? null : emailMask,
        phone: typeof normalizedPhone === 'undefined' ? current.phone : null,
        phone_hash: typeof phoneHash === 'undefined' ? (current as any).phone_hash ?? null : phoneHash,
        phone_mask: typeof phoneMask === 'undefined' ? (current as any).phone_mask ?? null : phoneMask,
        handle: typeof normalizedHandle === 'undefined' ? current.handle : normalizedHandle,
        handle_updated_at:
          typeof normalizedHandle === 'undefined'
            ? (current as any).handle_updated_at ?? null
            : user.handleUpdatedAt ?? now(),
        basename: typeof user.basename === 'undefined' ? (current as any).basename ?? null : user.basename,
        discoverable_by_handle: user.discoverableByHandle ?? current.discoverable_by_handle,
        discoverable_by_phone: user.discoverableByPhone ?? current.discoverable_by_phone,
        email_verified: user.emailVerified ?? current.email_verified,
        phone_verified: user.phoneVerified ?? current.phone_verified,
        balance: user.balance ?? current.balance,
        updated_at: now(),
      };
      return store.users[index];
    });
  }

  const database = sqliteDb as SqlDbLike;
  const sets: string[] = [];
  const values: any[] = [];

  if (typeof normalizedEmail !== 'undefined') {
    sets.push('email = ?');
    values.push(null);
    sets.push('email_hash = ?');
    values.push(emailHash ?? null);
    sets.push('email_mask = ?');
    values.push(emailMask ?? null);
  }
  if (typeof normalizedPhone !== 'undefined') {
    sets.push('phone = ?');
    values.push(null);
    sets.push('phone_hash = ?');
    values.push(phoneHash ?? null);
    sets.push('phone_mask = ?');
    values.push(phoneMask ?? null);
  }
  if (typeof normalizedHandle !== 'undefined') {
    sets.push('handle = ?');
    values.push(normalizedHandle);
    sets.push('handle_updated_at = ?');
    values.push(user.handleUpdatedAt ?? now());
  }
  if (typeof user.basename !== 'undefined') {
    sets.push('basename = ?');
    values.push(user.basename);
  }
  if (typeof user.discoverableByHandle !== 'undefined') {
    sets.push('discoverable_by_handle = ?');
    values.push(user.discoverableByHandle);
  }
  if (typeof user.discoverableByPhone !== 'undefined') {
    sets.push('discoverable_by_phone = ?');
    values.push(user.discoverableByPhone);
  }
  if (typeof user.emailVerified !== 'undefined') {
    sets.push('email_verified = ?');
    values.push(user.emailVerified);
  }
  if (typeof user.phoneVerified !== 'undefined') {
    sets.push('phone_verified = ?');
    values.push(user.phoneVerified);
  }
  if (typeof user.balance !== 'undefined') {
    sets.push('balance = ?');
    values.push(user.balance);
  }

  sets.push('updated_at = ?');
  values.push(now());
  values.push(user.id);

  if (sets.length === 1) {
    if (isPostgresBackend) {
      const row = await pgGet<any>('SELECT * FROM users WHERE id = ?', [user.id]);
      return row ?? null;
    }
    return database.prepare('SELECT * FROM users WHERE id = ?').get(user.id) ?? null;
  }

  if (isPostgresBackend) {
    const query = `UPDATE users SET ${sets.join(', ')} WHERE id = ?`;
    const prepared = withPostgresParams(query, values);
    await execPostgres(prepared.text, prepared.params);
    return (await pgGet<any>('SELECT * FROM users WHERE id = ?', [user.id])) ?? null;
  }

  const query = `UPDATE users SET ${sets.join(', ')} WHERE id = ?`;
  const result = database.prepare(query).run(...values);
  if (result.changes === 0) return null;
  return database.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

export async function getPricing(userId: string): Promise<any> {
  initBackend();
  if (useFallback) {
    return readJsonStore().pricingProfiles.find((p) => p.user_id === userId) ?? null;
  }
  if (isPostgresBackend) {
    const row = await pgGet<any>('SELECT * FROM pricing_profiles WHERE user_id = ?', [userId]);
    return row ?? null;
  }
  return (
    (sqliteDb as SqlDbLike).prepare('SELECT * FROM pricing_profiles WHERE user_id = ?').get(userId) ??
    null
  );
}

export async function setPricing(
  userId: string,
  value: { defaultPrice: number; firstContactPrice: number; returnDiscountBps: number; acceptsAll: boolean },
): Promise<any> {
  initBackend();
  if (useFallback) {
    return withJsonStore((store) => {
      const idx = store.pricingProfiles.findIndex((p) => p.user_id === userId);
      const payload = {
        user_id: userId,
        default_price: value.defaultPrice,
        first_contact_price: value.firstContactPrice,
        return_discount_bps: value.returnDiscountBps,
        accepts_all: value.acceptsAll ? 1 : 0,
      };

      if (idx === -1) {
        store.pricingProfiles.push(payload);
        return payload;
      }

      store.pricingProfiles[idx] = {
        ...store.pricingProfiles[idx],
        ...payload,
      };
      return store.pricingProfiles[idx];
    });
  }

  if (isPostgresBackend) {
    const stmt = `
      INSERT INTO pricing_profiles (user_id, default_price, first_contact_price, return_discount_bps, accepts_all)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET
        default_price = EXCLUDED.default_price,
        first_contact_price = EXCLUDED.first_contact_price,
        return_discount_bps = EXCLUDED.return_discount_bps,
        accepts_all = EXCLUDED.accepts_all
    `;
    await execPostgres(stmt, [
      userId,
      value.defaultPrice,
      value.firstContactPrice,
      value.returnDiscountBps,
      value.acceptsAll ? 1 : 0,
    ]);
    return (await pgGet<any>('SELECT * FROM pricing_profiles WHERE user_id = ?', [userId])) ?? null;
  }

  const database = sqliteDb as SqlDbLike;
  const stmt =
    `INSERT INTO pricing_profiles (user_id, default_price, first_contact_price, return_discount_bps, accepts_all)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
      default_price=excluded.default_price,
      first_contact_price=excluded.first_contact_price,
      return_discount_bps=excluded.return_discount_bps,
      accepts_all=excluded.accepts_all`;
  database.prepare(stmt).run(
    userId,
    value.defaultPrice,
    value.firstContactPrice,
    value.returnDiscountBps,
    value.acceptsAll ? 1 : 0,
  );
  return database.prepare('SELECT * FROM pricing_profiles WHERE user_id = ?').get(userId);
}

export async function createVerificationCode(
  userId: string,
  channel: string,
  target: string,
  code: string,
  ttlMs = 5 * 60 * 1000,
) {
  initBackend();
  const normalizedTarget =
    channel === 'email'
      ? normalizeEmail(target)
      : channel === 'phone'
        ? normalizePhone(target)
        : target.trim();
  const targetHash = hmacPii(normalizedTarget, `verify:${channel}`);

  if (useFallback) {
    return withJsonStore((store) => {
      const id = randomUUID();
      const ts = now();
      store.verificationCodes.push({
        id,
        user_id: userId,
        channel,
        target: targetHash,
        code,
        verified: 0,
        expires_at: ts + ttlMs,
        created_at: ts,
      });
      return { id };
    });
  }

  if (isPostgresBackend) {
    const ts = now();
    const id = randomUUID();
    await execPostgres(
      `
        INSERT INTO verification_codes (id, user_id, channel, target, code, verified, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
      `,
      [id, userId, channel, targetHash, code, ts + ttlMs, ts],
    );
    return { id };
  }

  const ts = now();
  const id = randomUUID();
  (sqliteDb as SqlDbLike).prepare(
    'INSERT INTO verification_codes (id, user_id, channel, target, code, verified, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
  ).run(id, userId, channel, targetHash, code, ts + ttlMs, ts);
  return { id };
}

export async function verifyCode(userId: string, channel: string, target: string, code: string): Promise<boolean> {
  initBackend();
  const normalizedTarget =
    channel === 'email'
      ? normalizeEmail(target)
      : channel === 'phone'
        ? normalizePhone(target)
        : target.trim();
  const targetHash = hmacPii(normalizedTarget, `verify:${channel}`);

  if (useFallback) {
    let matched: DbRow | null = null;
    return withJsonStore((store) => {
      const nowTs = now();
      for (let i = store.verificationCodes.length - 1; i >= 0; i -= 1) {
        const candidate = store.verificationCodes[i];
        if (
          candidate.user_id === userId &&
          candidate.channel === channel &&
          candidate.target === targetHash &&
          !candidate.verified
        ) {
          if (candidate.code !== code || candidate.expires_at < nowTs) {
            return false;
          }
          candidate.verified = 1;
          matched = candidate;
          break;
        }
      }
      return Boolean(matched);
    });
  }

  if (isPostgresBackend) {
    const row = await pgGet<{ id: string; code: string; expires_at: number }>(
      'SELECT id, code, expires_at FROM verification_codes WHERE user_id = $1 AND channel = $2 AND target = $3 AND verified = 0 ORDER BY created_at DESC LIMIT 1',
      [userId, channel, targetHash],
    );
    if (!row) return false;
    if (row.code !== code || row.expires_at < now()) {
      return false;
    }
    await execPostgres('UPDATE verification_codes SET verified = 1 WHERE id = $1', [row.id]);
    return true;
  }

  const database = sqliteDb as SqlDbLike;
  const row = database
    .prepare(
      'SELECT id, code, expires_at FROM verification_codes WHERE user_id = ? AND channel = ? AND target = ? AND verified = 0 ORDER BY created_at DESC LIMIT 1',
    )
    .get(userId, channel, targetHash) as { id: string; code: string; expires_at: number } | undefined;

  if (!row) return false;
  if (row.code !== code || row.expires_at < now()) {
    return false;
  }

  database.prepare('UPDATE verification_codes SET verified = 1 WHERE id = ?').run(row.id);
  return true;
}

export async function createMessage(record: {
  messageId: string;
  senderId: string;
  recipientId: string;
  ciphertext: string;
  contentHash: string;
  price: number;
  status: string;
  txHash?: string | null;
}): Promise<void> {
  initBackend();

  if (useFallback) {
    withJsonStore((store) => {
      store.messages.push({
        id: randomUUID(),
        message_id: record.messageId,
        sender_id: record.senderId,
        recipient_id: record.recipientId,
        ciphertext: record.ciphertext,
        content_hash: record.contentHash,
        price: record.price,
        status: record.status,
        tx_hash: record.txHash || null,
        created_at: now(),
      });
    });
    return;
  }

  if (isPostgresBackend) {
    await execPostgres(
      `
        INSERT INTO messages
          (id, message_id, sender_id, recipient_id, ciphertext, content_hash, price, status, tx_hash, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (message_id) DO NOTHING
      `,
      [
        randomUUID(),
        record.messageId,
        record.senderId,
        record.recipientId,
        record.ciphertext,
        record.contentHash,
        record.price,
        record.status,
        record.txHash ?? null,
        now(),
      ],
    );
    return;
  }

  const database = sqliteDb as SqlDbLike;
  database.prepare(
    `INSERT INTO messages
      (id, message_id, sender_id, recipient_id, ciphertext, content_hash, price, status, tx_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING`,
  ).run(randomUUID(), record.messageId, record.senderId, record.recipientId, record.ciphertext, record.contentHash, record.price, record.status, record.txHash ?? null, now());
}

export async function getMessageByMessageId(messageId: string): Promise<DbRow | null> {
  initBackend();
  if (useFallback) {
    return readJsonStore().messages.find((message) => message.message_id === messageId) ?? null;
  }

  if (isPostgresBackend) {
    return (await pgGet<DbRow>('SELECT * FROM messages WHERE message_id = ?', [messageId])) ?? null;
  }

  return (
    (sqliteDb as SqlDbLike).prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId) ?? null
  );
}

export async function getMessageIdByIdempotency(
  senderId: string,
  idempotencyKey: string,
): Promise<string | null> {
  if (!idempotencyKey) return null;
  initBackend();
  if (useFallback) {
    const entry = readJsonStore().messageIdempotency.find(
      (item) => item.sender_id === senderId && item.idempotency_key === idempotencyKey,
    );
    return entry?.message_id ?? null;
  }
  if (isPostgresBackend) {
    const row = await pgGet<{ message_id: string }>(
      'SELECT message_id FROM message_idempotency WHERE sender_id = ? AND idempotency_key = ?',
      [senderId, idempotencyKey],
    );
    return row?.message_id ?? null;
  }
  const row = (sqliteDb as SqlDbLike)
    .prepare('SELECT message_id FROM message_idempotency WHERE sender_id = ? AND idempotency_key = ?')
    .get(senderId, idempotencyKey) as { message_id: string } | undefined;
  return row?.message_id ?? null;
}

export async function saveMessageIdempotency(senderId: string, idempotencyKey: string, messageId: string): Promise<void> {
  if (!idempotencyKey) return;
  initBackend();
  if (useFallback) {
    return withJsonStore((store) => {
      const existing = store.messageIdempotency.find(
        (entry) => entry.sender_id === senderId && entry.idempotency_key === idempotencyKey,
      );
      if (existing) {
        return;
      }
      store.messageIdempotency.push({
        sender_id: senderId,
        idempotency_key: idempotencyKey,
        message_id: messageId,
        created_at: now(),
      });
    });
  }

  if (isPostgresBackend) {
    await execPostgres(
      `
        INSERT INTO message_idempotency (id, sender_id, idempotency_key, message_id, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (sender_id, idempotency_key) DO NOTHING
      `,
      [randomUUID(), senderId, idempotencyKey, messageId, now()],
    );
    return;
  }

  const database = sqliteDb as SqlDbLike;
  database
    .prepare(
      'INSERT INTO message_idempotency (sender_id, idempotency_key, message_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(sender_id, idempotency_key) DO NOTHING',
    )
    .run(senderId, idempotencyKey, messageId, now());
}

export async function getConnectedChannels(userId: string): Promise<DbRow[]> {
  initBackend();
  if (useFallback) {
    return readJsonStore().channelConnections.filter(
      (connection) => connection.user_id === userId && connection.status === 'connected' && isChannelConsentCurrent(connection),
    );
  }
  if (isPostgresBackend) {
    const rows = await pgAll<DbRow>('SELECT * FROM channel_connections WHERE user_id = ? AND status = ?', [
      userId,
      'connected',
    ]);
    return (rows ?? [])
      .map((row) => mapChannelConnection(row))
      .filter((row) => isChannelConsentCurrent(row));
  }
  return (
    (sqliteDb as SqlDbLike)
      .prepare('SELECT * FROM channel_connections WHERE user_id = ? AND status = ?')
      .all(userId, 'connected')
      .filter((row: DbRow) => isChannelConsentCurrent(row)) || []
  );
}

function createMessageDeliveryJobSync(payload: {
  messageId: string;
  userId: string;
  channel: string;
  destination: string;
  payload: Record<string, any>;
  maxAttempts?: number;
  nextAttemptAt?: number;
}) {
  const nowTs = now();
  const job: DeliveryJob = {
    id: randomUUID(),
    message_id: payload.messageId,
    user_id: payload.userId,
    channel: payload.channel,
    destination: payload.destination,
    payload_json: JSON.stringify(payload.payload),
    status: 'pending',
    attempts: 0,
    max_attempts: payload.maxAttempts ?? 5,
    next_attempt_at: payload.nextAttemptAt ?? nowTs,
    locked_by: null,
    locked_until: null,
    error_text: null,
    created_at: nowTs,
    updated_at: nowTs,
  };

  initBackend();
  if (useFallback) {
    withJsonStore((store) => {
      store.deliveryJobs.push(job);
    });
    return job;
  }

  const database = sqliteDb as SqlDbLike;
  database
    .prepare(
      `INSERT INTO delivery_jobs (
       id, message_id, user_id, channel, destination, payload_json, status, attempts,
       max_attempts, next_attempt_at, locked_by, locked_until, error_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.id,
      job.message_id,
      job.user_id,
      job.channel,
      job.destination,
      job.payload_json,
      job.status,
      job.attempts,
      job.max_attempts,
      job.next_attempt_at,
      job.locked_by,
      job.locked_until,
      job.error_text,
      job.created_at,
      job.updated_at,
    );

  return job;
}

async function createMessageDeliveryJobPostgres(payload: {
  messageId: string;
  userId: string;
  channel: string;
  destination: string;
  payload: Record<string, any>;
  maxAttempts?: number;
  nextAttemptAt?: number;
}): Promise<DeliveryJob> {
  const nowTs = now();
  const job: DeliveryJob = {
    id: randomUUID(),
    message_id: payload.messageId,
    user_id: payload.userId,
    channel: payload.channel,
    destination: payload.destination,
    payload_json: JSON.stringify(payload.payload),
    status: 'pending',
    attempts: 0,
    max_attempts: payload.maxAttempts ?? 5,
    next_attempt_at: payload.nextAttemptAt ?? nowTs,
    locked_by: null,
    locked_until: null,
    error_text: null,
    created_at: nowTs,
    updated_at: nowTs,
  };

  await ensurePostgresSchema();
  const rows = await queryPostgres<PostgresDeliveryRow>(
    `
      INSERT INTO delivery_jobs (
        id, message_id, user_id, channel, destination, payload_json, status, attempts,
        max_attempts, next_attempt_at, locked_by, locked_until, error_text, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (message_id, channel, destination)
      DO UPDATE SET updated_at = EXCLUDED.updated_at
      RETURNING *
    `,
    [
      job.id,
      job.message_id,
      job.user_id,
      job.channel,
      job.destination,
      job.payload_json,
      job.status,
      job.attempts,
      job.max_attempts,
      job.next_attempt_at,
      job.locked_by,
      job.locked_until,
      job.error_text,
      job.created_at,
      job.updated_at,
    ],
  );

  const inserted = rows[0] ?? job;
  return mapDeliveryJob(inserted);
}

export async function createMessageDeliveryJob(payload: {
  messageId: string;
  userId: string;
  channel: string;
  destination: string;
  payload: Record<string, any>;
  maxAttempts?: number;
  nextAttemptAt?: number;
}): Promise<DeliveryJob> {
  if (isPostgresBackend) {
    return createMessageDeliveryJobPostgres(payload);
  }
  return createMessageDeliveryJobSync(payload);
}

function getDeliveryJobsForMessageSync(messageId: string): DeliveryJob[] {
  initBackend();
  if (useFallback) {
    return readJsonStore().deliveryJobs.filter((job) => job.message_id === messageId) as DeliveryJob[];
  }
  return (sqliteDb as SqlDbLike).prepare('SELECT * FROM delivery_jobs WHERE message_id = ?').all(messageId) ?? [];
}

async function getDeliveryJobsForMessagePostgres(messageId: string): Promise<DeliveryJob[]> {
  await ensurePostgresSchema();
  const rows = await queryPostgres<PostgresDeliveryRow>(
    'SELECT * FROM delivery_jobs WHERE message_id = $1',
    [messageId],
  );
  return rows.map(mapDeliveryJob);
}

export async function getDeliveryJobsForMessage(messageId: string): Promise<DeliveryJob[]> {
  if (useFallback) {
    return getDeliveryJobsForMessageSync(messageId);
  }
  if (isPostgresBackend) {
    return getDeliveryJobsForMessagePostgres(messageId);
  }
  return getDeliveryJobsForMessageSync(messageId);
}

export async function queueNotificationJobsForMessage(params: {
  messageId: string;
  recipientId: string;
  recipientWallet: string;
  price: number;
  txHash: string | null | undefined;
}) {
  const channels = await getConnectedChannels(params.recipientId);
  const existingJobs = await getDeliveryJobsForMessage(params.messageId);
  if (existingJobs.length > 0) return;

  const payload = {
    subject: 'New paid message',
    messageId: params.messageId,
    amount: params.price,
    txHash: params.txHash ?? null,
  };

  if (channels.length === 0) {
    return;
  }

  for (const channel of channels) {
    if (!isChannelConsentCurrent(channel)) {
      incrementCounter('mmp_delivery_job_skip_total', { reason: 'stale_channel_consent', channel: channel.channel });
      continue;
    }
    if (!channel.external_handle) continue;
    await createMessageDeliveryJob({
      messageId: params.messageId,
      userId: params.recipientId,
      channel: channel.channel,
      destination: channel.external_handle,
      payload,
    });
  }
}

export async function claimDueDeliveryJobs(workerId: string, limit = 20): Promise<DeliveryJob[]> {
  initBackend();
  const nowTs = now();
  const lockUntil = nowTs + env.DELIVERY_WORKER_LOCK_TTL_MS;
  let lockToken = null;

  if (env.WORKER_DISTRIBUTED) {
    assertRedisForDistributedWorkersOrThrow('delivery worker');
    lockToken = await tryAcquireDistributedLock(deliveryClaimLockKey(), env.DELIVERY_WORKER_LOCK_TTL_MS);
    if (!lockToken) {
      return [];
    }
  }

  try {
    if (useFallback) {
      return withJsonStore((store) => {
        const eligible = store.deliveryJobs
          .filter(
            (job) =>
              job.status === 'pending' &&
              job.next_attempt_at <= nowTs &&
              (!job.locked_until || job.locked_until <= nowTs),
          )
          .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
          .slice(0, limit)
          .map((job) => {
            job.status = 'processing';
            job.attempts = (job.attempts || 0) + 1;
            job.locked_by = workerId;
            job.locked_until = lockUntil;
            job.updated_at = nowTs;
            job.error_text = null;
            return { ...job };
          });
        return eligible as DeliveryJob[];
      });
    }

    if (!isPostgresBackend) {
      const rows = (sqliteDb as SqlDbLike)
        .prepare(
          `SELECT * FROM delivery_jobs
           WHERE status = 'pending'
             AND next_attempt_at <= ?
             AND (locked_until IS NULL OR locked_until <= ?)
           ORDER BY next_attempt_at ASC, created_at ASC
           LIMIT ?`,
        )
        .all(nowTs, nowTs, limit) as DeliveryJob[];

      for (const row of rows) {
        (sqliteDb as SqlDbLike)
          .prepare(
            `UPDATE delivery_jobs
             SET status = 'processing', locked_by = ?, locked_until = ?, attempts = attempts + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(workerId, lockUntil, nowTs, row.id);
      }

      return rows.map((job) => ({
        ...job,
        status: 'processing',
        locked_by: workerId,
        locked_until: lockUntil,
      }));
    }

    await ensurePostgresSchema();
    const rows = await queryPostgres<PostgresDeliveryRow>(
      `
        WITH candidates AS (
          SELECT id
          FROM delivery_jobs
          WHERE status = 'pending'
            AND next_attempt_at <= $1
            AND (locked_until IS NULL OR locked_until <= $1)
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE delivery_jobs
        SET status = 'processing',
            locked_by = $3,
            locked_until = $4,
            attempts = attempts + 1,
            updated_at = $5,
            error_text = NULL
        FROM candidates
        WHERE delivery_jobs.id = candidates.id
        RETURNING delivery_jobs.*;
      `,
      [nowTs, limit, workerId, lockUntil, nowTs],
    );
    return rows.map(mapDeliveryJob);
  } finally {
    if (lockToken) {
      await releaseDistributedLock(deliveryClaimLockKey(), lockToken);
    }
  }
}

export async function markDeliveryJobDone(jobId: string) {
  initBackend();
  if (useFallback) {
    return withJsonStore((store) => {
      const job = store.deliveryJobs.find((item) => item.id === jobId);
      if (!job) return;
      job.status = 'done';
      job.locked_until = null;
      job.error_text = null;
      job.updated_at = now();
      return job;
    });
  }

  if (!isPostgresBackend) {
    (sqliteDb as SqlDbLike)
      .prepare(
        `UPDATE delivery_jobs
         SET status = 'done', locked_by = NULL, locked_until = NULL, error_text = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(now(), jobId);
    return;
  }

  await ensurePostgresSchema();
  await execPostgres(
    `
      UPDATE delivery_jobs
      SET status = 'done', locked_by = NULL, locked_until = NULL, error_text = NULL, updated_at = $1
      WHERE id = $2
    `,
    [now(), jobId],
  );
}

export async function markDeliveryJobFailed(jobId: string, reason: string, retryAt: number | null = null) {
  initBackend();
  if (useFallback) {
    return withJsonStore((store) => {
      const job = store.deliveryJobs.find((item) => item.id === jobId);
      if (!job) return;
      job.updated_at = now();
      job.error_text = reason;
      job.locked_by = null;
      job.locked_until = null;
      job.status = 'failed';
      if (retryAt !== null) {
        job.status = 'pending';
        job.next_attempt_at = retryAt;
      }
      return job;
    });
  }

  if (!isPostgresBackend) {
    if (retryAt === null) {
      (sqliteDb as SqlDbLike)
        .prepare(
          `UPDATE delivery_jobs
           SET status = 'failed', error_text = ?, locked_by = NULL, locked_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(reason, now(), jobId);
      return;
    }

    (sqliteDb as SqlDbLike)
      .prepare(
        `UPDATE delivery_jobs
         SET status = 'pending', error_text = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(reason, retryAt, now(), jobId);
    return;
  }

  await ensurePostgresSchema();
  if (retryAt === null) {
    await execPostgres(
      `
        UPDATE delivery_jobs
        SET status = 'failed', error_text = $1, locked_by = NULL, locked_until = NULL, updated_at = $2
        WHERE id = $3
      `,
      [reason, now(), jobId],
    );
    return;
  }

  await execPostgres(
    `
      UPDATE delivery_jobs
      SET status = 'pending', error_text = $1, next_attempt_at = $2, locked_by = NULL, locked_until = NULL, updated_at = $3
      WHERE id = $4
    `,
    [reason, retryAt, now(), jobId],
  );
}

export async function getPendingDeliveryJobs(limit = 50): Promise<DeliveryJob[]> {
  initBackend();
  if (useFallback) {
    return readJsonStore()
      .deliveryJobs.filter((job) => job.status === 'pending')
      .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
      .slice(0, limit) as DeliveryJob[];
  }
  if (!isPostgresBackend) {
    return (
      (sqliteDb as SqlDbLike)
        .prepare(
          'SELECT * FROM delivery_jobs WHERE status = ? ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?',
        )
        .all('pending', limit) ?? []
    );
  }

  await ensurePostgresSchema();
  const rows = await queryPostgres<PostgresDeliveryRow>(
    'SELECT * FROM delivery_jobs WHERE status = $1 ORDER BY next_attempt_at ASC, created_at ASC LIMIT $2',
    ['pending', limit],
  );
  return rows.map(mapDeliveryJob);
}

export async function getOldestPendingDeliveryJob() {
  initBackend();
  if (useFallback) {
    const job = readJsonStore().deliveryJobs
      .filter((item) => item.status === 'pending')
      .sort((a, b) => Number(a.created_at) - Number(b.created_at))[0];
    return job ?? null;
  }
  if (!isPostgresBackend) {
    const row = (sqliteDb as SqlDbLike)
      .prepare('SELECT * FROM delivery_jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1')
      .get('pending') as DeliveryJob | undefined;
    return row || null;
  }
  await ensurePostgresSchema();
  const rows = await queryPostgres<PostgresDeliveryRow>(
    'SELECT * FROM delivery_jobs WHERE status = $1 ORDER BY created_at ASC LIMIT 1',
    ['pending'],
  );
  return rows[0] ? mapDeliveryRow(rows[0]) : null;
}

function mapDeliveryRow(row: PostgresDeliveryRow) {
  return mapDeliveryJob(row);
}

export async function getDeliveryJobStats() {
  initBackend();
  if (useFallback) {
    const jobs = readJsonStore().deliveryJobs as DeliveryJob[];
    return {
      total: jobs.length,
      pending: jobs.filter((job) => job.status === 'pending').length,
      processing: jobs.filter((job) => job.status === 'processing').length,
      done: jobs.filter((job) => job.status === 'done').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
      deadLetter: jobs.filter((job) => job.error_text?.startsWith('max_retries_reached:')).length,
    };
  }

  if (isPostgresBackend) {
    const [rows, deadLetterRows] = await Promise.all([
      queryPostgres<{ status: string; count: string | number }>(
        'SELECT status, COUNT(1) AS count FROM delivery_jobs GROUP BY status',
      ),
      queryPostgres<{ count: string | number }>(
        "SELECT COUNT(1) AS count FROM delivery_jobs WHERE status = 'failed' AND error_text LIKE 'max_retries_reached:%'",
      ),
    ]);

    const totals = {
      total: 0,
      pending: 0,
      processing: 0,
      done: 0,
      failed: 0,
      deadLetter: Number(deadLetterRows[0]?.count ?? 0),
    };

    for (const row of rows) {
      const count = Number(row.count ?? 0);
      totals.total += count;
      if (row.status === 'pending') totals.pending = count;
      if (row.status === 'processing') totals.processing = count;
      if (row.status === 'done') totals.done = count;
      if (row.status === 'failed') totals.failed = count;
    }

    return totals;
  }

  const rows =
    (sqliteDb as SqlDbLike)
      .prepare('SELECT status, COUNT(1) AS count FROM delivery_jobs GROUP BY status')
      .all() as Array<{ status: string; count: number }>;

  const deadLetterRows =
    ((sqliteDb as SqlDbLike)
      .prepare("SELECT COUNT(1) AS count FROM delivery_jobs WHERE status = 'failed' AND error_text LIKE 'max_retries_reached:%'")
      .get() as { count: number }) || { count: 0 };

  const totals = {
    total: 0,
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    deadLetter: Number(deadLetterRows?.count ?? 0),
  };

  for (const row of rows) {
    const count = Number(row.count);
    totals.total += count;
    if (row.status === 'pending') totals.pending = count;
    if (row.status === 'processing') totals.processing = count;
    if (row.status === 'done') totals.done = count;
    if (row.status === 'failed') totals.failed = count;
  }

  return totals;
}

function normalizeChainKey(input: string) {
  return input.toLowerCase();
}

export async function getChainEventCheckpoint(chainKey: string): Promise<number | null> {
  initBackend();
  const normalizedChainKey = normalizeChainKey(chainKey);
  if (useFallback) {
    const row = readJsonStore().chainEventCheckpoints.find((row) => row.chain_key === normalizedChainKey);
    return row ? Number(row.last_processed_block) : null;
  }
  if (!isPostgresBackend) {
    const row = (sqliteDb as SqlDbLike)
      .prepare('SELECT last_processed_block FROM chain_event_checkpoints WHERE chain_key = ?')
      .get(normalizedChainKey) as { last_processed_block: number } | undefined;
    return row ? row.last_processed_block : null;
  }

  await ensurePostgresSchema();
  const rows = await queryPostgres<PostgresCheckpointRow>(
    'SELECT last_processed_block FROM chain_event_checkpoints WHERE chain_key = $1',
    [normalizedChainKey],
  );
  if (!rows.length) return null;
  return Number(rows[0].last_processed_block);
}

export async function getChainEventCheckpoints() {
  initBackend();
  if (useFallback) {
    return readJsonStore().chainEventCheckpoints;
  }

  if (!isPostgresBackend) {
    return (
      ((sqliteDb as SqlDbLike)
        .prepare('SELECT chain_key, last_processed_block, updated_at FROM chain_event_checkpoints ORDER BY chain_key ASC')
        .all() as Array<{ chain_key: string; last_processed_block: number; updated_at: number }>) || []
    );
  }

  const rows = await queryPostgres<{ chain_key: string; last_processed_block: number; updated_at: number }>(
    'SELECT chain_key, last_processed_block, updated_at FROM chain_event_checkpoints ORDER BY chain_key ASC',
  );
  return rows;
}

export async function setChainEventCheckpoint(chainKey: string, blockNumber: number) {
  const ts = now();
  const normalizedChainKey = normalizeChainKey(chainKey);
  initBackend();
  if (useFallback) {
    return withJsonStore((store) => {
      const checkpoint = store.chainEventCheckpoints.find((entry) => entry.chain_key === normalizedChainKey);
      if (checkpoint) {
        checkpoint.last_processed_block = blockNumber;
        checkpoint.updated_at = ts;
        return;
      }
      store.chainEventCheckpoints.push({
        id: randomUUID(),
        chain_key: normalizedChainKey,
        last_processed_block: blockNumber,
        updated_at: ts,
      });
    });
  }
  if (!isPostgresBackend) {
    (sqliteDb as SqlDbLike).prepare(`
      INSERT INTO chain_event_checkpoints (chain_key, last_processed_block, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chain_key) DO UPDATE SET last_processed_block = excluded.last_processed_block, updated_at = excluded.updated_at
    `).run(normalizedChainKey, blockNumber, ts);
    return;
  }

  await ensurePostgresSchema();
  await execPostgres(
    `
      INSERT INTO chain_event_checkpoints (chain_key, last_processed_block, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (chain_key) DO UPDATE SET last_processed_block = EXCLUDED.last_processed_block, updated_at = EXCLUDED.updated_at
    `,
    [normalizedChainKey, blockNumber, ts],
  );
}

export async function saveChainEvent(event: {
  chainKey: string;
  blockNumber: number;
  blockHash: string | null;
  txHash: string;
  logIndex: number;
  messageId: string;
  payer: string;
  recipient: string;
  amount: number;
  fee: number;
  contentHash: string;
  nonce: number;
  channel: number;
  observedAt?: number;
}) {
  const nowTs = now();
  initBackend();
  const payload = {
    id: randomUUID(),
    chain_key: normalizeChainKey(event.chainKey),
    block_number: event.blockNumber,
    block_hash: event.blockHash,
    tx_hash: event.txHash.toLowerCase(),
    log_index: event.logIndex,
    message_id: event.messageId.toLowerCase(),
    payer: event.payer.toLowerCase(),
    recipient: event.recipient.toLowerCase(),
    amount: String(event.amount),
    fee: String(event.fee),
    content_hash: event.contentHash.toLowerCase(),
    nonce: event.nonce,
    channel: event.channel,
    observed_at: event.observedAt ?? nowTs,
    created_at: nowTs,
  };
  if (useFallback) {
    return withJsonStore((store) => {
      const exists = store.chainEvents.find(
        (row) =>
          row.chain_key === payload.chain_key &&
          row.tx_hash === payload.tx_hash &&
          row.log_index === payload.log_index,
      );
      if (!exists) {
        store.chainEvents.push(payload);
      }
    });
  }
  if (!isPostgresBackend) {
    const database = sqliteDb as SqlDbLike;
    database.prepare(
      `INSERT INTO chain_events (
       id, chain_key, block_number, block_hash, tx_hash, log_index, message_id, payer, recipient,
       amount, fee, content_hash, nonce, channel, observed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_key, tx_hash, log_index) DO NOTHING`,
    ).run(
      payload.id,
      payload.chain_key,
      payload.block_number,
      payload.block_hash,
      payload.tx_hash,
      payload.log_index,
      payload.message_id,
      payload.payer,
      payload.recipient,
      payload.amount,
      payload.fee,
      payload.content_hash,
      payload.nonce,
      payload.channel,
      payload.observed_at,
      payload.created_at,
    );
    return;
  }

  await ensurePostgresSchema();
  await execPostgres(
    `
      INSERT INTO chain_events (
        id, chain_key, block_number, block_hash, tx_hash, log_index, message_id, payer, recipient,
        amount, fee, content_hash, nonce, channel, observed_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT(chain_key, tx_hash, log_index) DO NOTHING
    `,
    [
      payload.id,
      payload.chain_key,
      payload.block_number,
      payload.block_hash,
      payload.tx_hash,
      payload.log_index,
      payload.message_id,
      payload.payer,
      payload.recipient,
      payload.amount,
      payload.fee,
      payload.content_hash,
      payload.nonce,
      payload.channel,
      payload.observed_at,
      payload.created_at,
    ],
  );
}

export async function getInbox(recipientId: string): Promise<DbRow[]> {
  initBackend();

  if (useFallback) {
    const messages = readJsonStore()
      .messages.filter((m) => m.recipient_id === recipientId)
      .sort((a, b) => b.created_at - a.created_at);

    const senderIds = [...new Set(messages.map((item) => item.sender_id))];
    const senderRows = await Promise.all(senderIds.map((senderId) => getUserById(senderId)));
    const senderWalletById = new Map(senderRows.map((sender, idx) => [senderIds[idx], sender?.wallet_address || '']));

    return messages.map((message) => ({
      ...message,
      sender_wallet: senderWalletById.get(message.sender_id) || '',
    }));
  }

  if (isPostgresBackend) {
    const rows = await pgAll<DbRow & { sender_wallet: string }>(
      `
        SELECT m.*, u.wallet_address AS sender_wallet
          FROM messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.recipient_id = $1
          ORDER BY m.created_at DESC
      `,
      [recipientId],
    );
    return rows ?? [];
  }

  return (
    (sqliteDb as SqlDbLike)
      .prepare(
        `SELECT m.*, u.wallet_address AS sender_wallet
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.recipient_id = ?
         ORDER BY m.created_at DESC`,
      )
      .all(recipientId) ?? []
  );
}

export async function updateMessageStatus(messageId: string, status: string, txHash?: string | null) {
  initBackend();
  if (useFallback) {
    withJsonStore((store) => {
      const idx = store.messages.findIndex((m) => m.message_id === messageId);
      if (idx === -1) return null;
      const msg = store.messages[idx];
      msg.status = status;
      if (txHash) {
        msg.tx_hash = txHash;
      }
      store.messages[idx] = msg;
      return null;
    });
    return;
  }

  if (txHash) {
    if (isPostgresBackend) {
      await execPostgres('UPDATE messages SET status = $1, tx_hash = $2 WHERE message_id = $3', [status, txHash, messageId]);
    } else {
      (sqliteDb as SqlDbLike).prepare('UPDATE messages SET status = ?, tx_hash = ? WHERE message_id = ?').run(
        status,
        txHash,
        messageId,
      );
    }
    return;
  }
  if (isPostgresBackend) {
    await execPostgres('UPDATE messages SET status = $1 WHERE message_id = $2', [status, messageId]);
  } else {
    (sqliteDb as SqlDbLike).prepare('UPDATE messages SET status = ? WHERE message_id = ?').run(status, messageId);
  }
}

export async function changeBalance(userId: string, delta: number): Promise<any> {
  initBackend();
  if (useFallback) {
    return withJsonStore((store) => {
      const idx = store.users.findIndex((u) => u.id === userId);
      if (idx === -1) return null;
      const user = store.users[idx];
      user.balance = (user.balance ?? 0) + delta;
      user.updated_at = now();
      return user;
    });
  }

  if (isPostgresBackend) {
    await execPostgres('UPDATE users SET balance = balance + $1, updated_at = $2 WHERE id = $3', [delta, now(), userId]);
    const row = await pgGet<any>('SELECT * FROM users WHERE id = ?', [userId]);
    return row ?? null;
  }

  const database = sqliteDb as SqlDbLike;
  database.prepare('UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?').run(delta, now(), userId);
  return database.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

export async function setBalance(userId: string, balance: number): Promise<any> {
  initBackend();
  if (useFallback) {
    return withJsonStore((store) => {
      const idx = store.users.findIndex((u) => u.id === userId);
      if (idx === -1) return null;
      store.users[idx].balance = balance;
      store.users[idx].updated_at = now();
      return store.users[idx];
    });
  }

  if (isPostgresBackend) {
    await execPostgres('UPDATE users SET balance = $1, updated_at = $2 WHERE id = $3', [balance, now(), userId]);
    const row = await pgGet<any>('SELECT * FROM users WHERE id = ?', [userId]);
    return row ?? null;
  }

  const database = sqliteDb as SqlDbLike;
  database.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE id = ?').run(balance, now(), userId);
  return database.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

export async function saveChannelConnection(
  userId: string,
  channel: string,
  payload: ChannelConnectionPayload,
) {
  initBackend();
  const nowTs = now();
  const consentAcceptedAt = payload.consentAcceptedAt ?? null;

  if (useFallback) {
    return withJsonStore((store) => {
      const idx = store.channelConnections.findIndex((c) => c.user_id === userId && c.channel === channel);
      const ts = nowTs;
      const previous = idx === -1 ? null : store.channelConnections[idx];
      const entry = {
        user_id: userId,
        channel,
        external_handle: payload.externalHandle,
        secret_ref: payload.secretRef,
        consent_version: payload.consentVersion,
        consent_accepted_at: consentAcceptedAt,
        status: payload.status,
        created_at: ts,
        updated_at: ts,
      };
      if (idx === -1) {
        store.channelConnections.push(entry);
      } else {
        store.channelConnections[idx] = {
          ...previous,
          ...entry,
          created_at: previous?.created_at ?? entry.created_at,
          updated_at: ts,
        };
      }
    });
  }

  if (isPostgresBackend) {
    await execPostgres(
      `
        INSERT INTO channel_connections (id, user_id, channel, external_handle, secret_ref, consent_version, consent_accepted_at, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (user_id, channel) DO UPDATE SET
          external_handle = EXCLUDED.external_handle,
          secret_ref = EXCLUDED.secret_ref,
          consent_version = EXCLUDED.consent_version,
          consent_accepted_at = EXCLUDED.consent_accepted_at,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `,
      [
        randomUUID(),
        userId,
        channel,
        payload.externalHandle,
        payload.secretRef,
        payload.consentVersion,
        consentAcceptedAt,
        payload.status,
        nowTs,
        nowTs,
      ],
    );
    return;
  }

  const database = sqliteDb as SqlDbLike;
  database.prepare(
    `INSERT INTO channel_connections (user_id, channel, external_handle, secret_ref, consent_version, consent_accepted_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, channel) DO UPDATE SET
      external_handle = excluded.external_handle,
      secret_ref = excluded.secret_ref,
      consent_version = excluded.consent_version,
      consent_accepted_at = excluded.consent_accepted_at,
      status = excluded.status,
      updated_at = excluded.updated_at`,
  ).run(
    userId,
    channel,
    payload.externalHandle,
    payload.secretRef,
    payload.consentVersion,
    consentAcceptedAt,
    payload.status,
    nowTs,
    nowTs,
  );
}

export async function getChannelConnection(userId: string, channel: string): Promise<any> {
  initBackend();
  if (useFallback) {
    return (
      readJsonStore().channelConnections.find((c) => c.user_id === userId && c.channel === channel) ?? null
    );
  }

  if (isPostgresBackend) {
    const row = await pgGet<any>('SELECT * FROM channel_connections WHERE user_id = $1 AND channel = $2', [
      userId,
      channel,
    ]);
    return row ? mapChannelConnection(row) : null;
  }

  return (
    (sqliteDb as SqlDbLike)
      .prepare('SELECT * FROM channel_connections WHERE user_id = ? AND channel = ?')
      .get(userId, channel) ?? null
  );
}

export async function getIdentityBinding(method: string, provider: string, subject: string): Promise<IdentityBindingRecord | null> {
  initBackend();
  const normalizedMethod = method.toLowerCase();
  const normalizedProvider = provider.toLowerCase();
  const normalizedSubject = subject;

  if (useFallback) {
    const binding = readJsonStore().identityBindings.find(
      (entry) =>
        entry.method === normalizedMethod &&
        entry.provider === normalizedProvider &&
        entry.subject === normalizedSubject &&
        entry.revoked_at == null,
    );
    if (!binding) return null;
    return {
      id: binding.id,
      userId: binding.user_id,
      method: binding.method,
      provider: binding.provider,
      subject: binding.subject,
      walletAddress: binding.wallet_address,
      linkedAt: Number(binding.linked_at),
      lastSeenAt: Number(binding.last_seen_at),
      revokedAt: binding.revoked_at == null ? null : Number(binding.revoked_at),
    };
  }

  const rows = isPostgresBackend
    ? await pgAll<PostgresIdentityBindingRow>(
        `SELECT * FROM identity_bindings WHERE method = ? AND provider = ? AND subject = ? AND revoked_at IS NULL`,
        [normalizedMethod, normalizedProvider, normalizedSubject],
      )
    : ((sqliteDb as SqlDbLike)
        .prepare(
          'SELECT * FROM identity_bindings WHERE method = ? AND provider = ? AND subject = ? AND revoked_at IS NULL',
        )
        .all(normalizedMethod, normalizedProvider, normalizedSubject) as PostgresIdentityBindingRow[]);

  if (!rows.length) return null;
  return mapIdentityBinding(rows[0]);
}

export async function saveIdentityBinding(payload: IdentityBindingPayload): Promise<IdentityBindingRecord> {
  initBackend();
  const nowTs = payload.linkedAt ?? now();
  const lastSeen = payload.lastSeenAt ?? nowTs;
  const method = payload.method.toLowerCase();
  const provider = payload.provider.toLowerCase();
  const subject = payload.subject;
  const walletAddress = payload.walletAddress.toLowerCase();

  if (useFallback) {
    return withJsonStore((store) => {
      const existingByKey = store.identityBindings.findIndex(
        (entry) => entry.method === method && entry.provider === provider && entry.subject === subject,
      );
      const existingByWallet = store.identityBindings.findIndex((entry) => entry.wallet_address === walletAddress);

      if (existingByWallet !== -1) {
        const walletEntry = store.identityBindings[existingByWallet];
        if (walletEntry.method !== method || walletEntry.provider !== provider || walletEntry.subject !== subject) {
          throw new Error('identity_wallet_collision');
        }
      }

      const row = {
        id: randomUUID(),
        user_id: payload.userId,
        method,
        provider,
        subject,
        wallet_address: walletAddress,
        linked_at: nowTs,
        last_seen_at: lastSeen,
        revoked_at: payload.revokedAt ?? null,
      };

      if (existingByKey === -1) {
        store.identityBindings.push(row);
        return {
          id: row.id,
          userId: row.user_id,
          method: row.method,
          provider: row.provider,
          subject: row.subject,
          walletAddress: row.wallet_address,
          linkedAt: row.linked_at,
          lastSeenAt: row.last_seen_at,
          revokedAt: null,
        };
      }

      const target = store.identityBindings[existingByKey];
      target.user_id = payload.userId;
      target.wallet_address = walletAddress;
      target.last_seen_at = lastSeen;
      target.linked_at = nowTs;
      target.revoked_at = null;
      return {
        id: target.id,
        userId: target.user_id,
        method: target.method,
        provider: target.provider,
        subject: target.subject,
        walletAddress: target.wallet_address,
        linkedAt: target.linked_at,
        lastSeenAt: target.last_seen_at,
        revokedAt: target.revoked_at,
      };
    });
  }

  if (isPostgresBackend) {
    const candidate = await getIdentityBinding(method, provider, subject);
    if (candidate && candidate.walletAddress !== walletAddress) {
      const conflict = await queryPostgres<PostgresIdentityBindingRow>(
        'SELECT id FROM identity_bindings WHERE wallet_address = $1 AND revoked_at IS NULL',
        [walletAddress],
      );
      if (conflict.length) {
        throw new Error('identity_wallet_collision');
      }
    }

    let rows: PostgresIdentityBindingRow[] = [];
    try {
      rows = await queryPostgres<PostgresIdentityBindingRow>(
        `
          INSERT INTO identity_bindings (
            id, user_id, method, provider, subject, wallet_address, linked_at, last_seen_at, revoked_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9
          )
          ON CONFLICT (method, provider, subject) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                wallet_address = EXCLUDED.wallet_address,
                linked_at = EXCLUDED.linked_at,
                last_seen_at = EXCLUDED.last_seen_at,
                revoked_at = NULL
          RETURNING *
        `,
        [randomUUID(), payload.userId, method, provider, subject, walletAddress, nowTs, lastSeen, payload.revokedAt ?? null],
      );
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new Error('identity_wallet_collision');
      }
      throw error;
    }

    const row = rows[0];
    return mapIdentityBinding(row);
  }

  const database = sqliteDb as SqlDbLike;
  const walletCollision = database
    .prepare('SELECT id FROM identity_bindings WHERE wallet_address = ? AND revoked_at IS NULL')
    .get(walletAddress) as { id: string } | undefined;

  const existingForKey = database
    .prepare(
      'SELECT * FROM identity_bindings WHERE method = ? AND provider = ? AND subject = ?',
    )
    .get(method, provider, subject) as PostgresIdentityBindingRow | undefined;

  if (walletCollision && (!existingForKey || existingForKey.id !== walletCollision.id)) {
    throw new Error('identity_wallet_collision');
  }

  database
    .prepare(
      `INSERT INTO identity_bindings (
        user_id, method, provider, subject, wallet_address, linked_at, last_seen_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(method, provider, subject) DO UPDATE SET
        user_id = excluded.user_id,
        wallet_address = excluded.wallet_address,
        linked_at = excluded.linked_at,
        last_seen_at = excluded.last_seen_at,
        revoked_at = NULL`,
    )
    .run(payload.userId, method, provider, subject, walletAddress, nowTs, lastSeen);

  const row = await getIdentityBinding(method, provider, subject);
  if (!row) {
    throw new Error('identity_binding_not_found');
  }

  return row;
}

export async function revokeIdentityBinding(method: string, provider: string, subject: string) {
  initBackend();
  const nowTs = now();
  const normalizedMethod = method.toLowerCase();
  const normalizedProvider = provider.toLowerCase();

  if (useFallback) {
    return withJsonStore((store) => {
      const row = store.identityBindings.find(
        (entry) =>
          entry.method === normalizedMethod &&
          entry.provider === normalizedProvider &&
          entry.subject === subject &&
          entry.revoked_at == null,
      );
      if (!row) return null;
      row.revoked_at = nowTs;
      row.last_seen_at = nowTs;
      return row;
    });
  }

  if (isPostgresBackend) {
    await execPostgres(
      `
        UPDATE identity_bindings
        SET revoked_at = $1, last_seen_at = $1
        WHERE method = $2 AND provider = $3 AND subject = $4 AND revoked_at IS NULL
      `,
      [nowTs, normalizedMethod, normalizedProvider, subject],
    );
    return;
  }

  (sqliteDb as SqlDbLike).prepare(
    `UPDATE identity_bindings
     SET revoked_at = ?, last_seen_at = ?
     WHERE method = ? AND provider = ? AND subject = ? AND revoked_at IS NULL`,
  ).run(nowTs, nowTs, normalizedMethod, normalizedProvider, subject);
}

export type CustodialWalletRecord = {
  userId: string;
  walletAddress: string;
  encryptedPrivateKeyJson: string;
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
};

type CustodialWalletRow = {
  user_id: string;
  wallet_address: string;
  encrypted_private_key_json: string;
  key_version: string | number;
  created_at: string | number;
  updated_at: string | number;
};

function mapCustodialWallet(row: CustodialWalletRow): CustodialWalletRecord {
  return {
    userId: row.user_id,
    walletAddress: row.wallet_address,
    encryptedPrivateKeyJson: row.encrypted_private_key_json,
    keyVersion: Number(row.key_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getCustodialWallet(userId: string): Promise<CustodialWalletRecord | null> {
  initBackend();
  if (useFallback) {
    const row = readJsonStore().custodialWallets.find((entry) => entry.user_id === userId) ?? null;
    if (!row) return null;
    return {
      userId: row.user_id,
      walletAddress: row.wallet_address,
      encryptedPrivateKeyJson: row.encrypted_private_key_json,
      keyVersion: Number(row.key_version ?? 1),
      createdAt: Number(row.created_at ?? now()),
      updatedAt: Number(row.updated_at ?? now()),
    };
  }

  if (isPostgresBackend) {
    await ensurePostgresSchema();
    const row = await pgGet<CustodialWalletRow>('SELECT * FROM custodial_wallets WHERE user_id = ?', [userId]);
    return row ? mapCustodialWallet(row) : null;
  }

  const row = (sqliteDb as SqlDbLike)
    .prepare('SELECT * FROM custodial_wallets WHERE user_id = ?')
    .get(userId) as CustodialWalletRow | undefined;
  if (!row) return null;
  return mapCustodialWallet(row);
}

export async function upsertCustodialWallet(params: {
  userId: string;
  walletAddress: string;
  encryptedPrivateKeyJson: string;
  keyVersion?: number;
}): Promise<CustodialWalletRecord> {
  initBackend();
  const ts = now();
  const keyVersion = params.keyVersion ?? 1;

  if (useFallback) {
    return withJsonStore((store) => {
      const walletAddress = params.walletAddress.toLowerCase();
      const collision = store.custodialWallets.find(
        (entry) => entry.wallet_address === walletAddress && entry.user_id !== params.userId,
      );
      if (collision) {
        throw new Error('custodial_wallet_collision');
      }

      const idx = store.custodialWallets.findIndex((entry) => entry.user_id === params.userId);
      const row = {
        user_id: params.userId,
        wallet_address: walletAddress,
        encrypted_private_key_json: params.encryptedPrivateKeyJson,
        key_version: keyVersion,
        created_at: ts,
        updated_at: ts,
      };
      if (idx === -1) {
        store.custodialWallets.push(row);
      } else {
        store.custodialWallets[idx] = { ...store.custodialWallets[idx], ...row, updated_at: ts };
      }
      return {
        userId: row.user_id,
        walletAddress: row.wallet_address,
        encryptedPrivateKeyJson: row.encrypted_private_key_json,
        keyVersion: Number(row.key_version),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      };
    });
  }

  if (isPostgresBackend) {
    await ensurePostgresSchema();
    const rows = await queryPostgres<CustodialWalletRow>(
      `
        INSERT INTO custodial_wallets (user_id, wallet_address, encrypted_private_key_json, key_version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id) DO UPDATE
          SET wallet_address = EXCLUDED.wallet_address,
              encrypted_private_key_json = EXCLUDED.encrypted_private_key_json,
              key_version = EXCLUDED.key_version,
              updated_at = EXCLUDED.updated_at
        RETURNING *
      `,
      [params.userId, params.walletAddress.toLowerCase(), params.encryptedPrivateKeyJson, keyVersion, ts, ts],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('custodial_wallet_upsert_failed');
    }
    return mapCustodialWallet(row);
  }

  const database = sqliteDb as SqlDbLike;
  database
    .prepare(
      `
        INSERT INTO custodial_wallets (user_id, wallet_address, encrypted_private_key_json, key_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          wallet_address = excluded.wallet_address,
          encrypted_private_key_json = excluded.encrypted_private_key_json,
          key_version = excluded.key_version,
          updated_at = excluded.updated_at
      `,
    )
    .run(params.userId, params.walletAddress.toLowerCase(), params.encryptedPrivateKeyJson, keyVersion, ts, ts);

  const row = database
    .prepare('SELECT * FROM custodial_wallets WHERE user_id = ?')
    .get(params.userId) as CustodialWalletRow | undefined;
  if (!row) {
    throw new Error('custodial_wallet_not_found');
  }
  return mapCustodialWallet(row);
}

export type PasskeyCredentialRecord = {
  id: string;
  userId: string;
  userHandle: string;
  rpId: string;
  credentialId: string;
  publicKeyB64: string;
  counter: number;
  transports: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

type PasskeyCredentialRow = {
  id: string;
  user_id: string;
  user_handle: string;
  rp_id: string;
  credential_id: string;
  public_key_b64: string;
  counter: string | number;
  transports: string | null;
  created_at: string | number;
  updated_at: string | number;
  last_used_at: string | number | null;
  revoked_at: string | number | null;
};

function mapPasskeyCredential(row: PasskeyCredentialRow): PasskeyCredentialRecord {
  return {
    id: row.id,
    userId: row.user_id,
    userHandle: row.user_handle,
    rpId: row.rp_id,
    credentialId: row.credential_id,
    publicKeyB64: row.public_key_b64,
    counter: Number(row.counter),
    transports: row.transports,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

export async function createPasskeyCredential(params: {
  userId: string;
  userHandle: string;
  rpId: string;
  credentialId: string;
  publicKeyB64: string;
  counter: number;
  transports?: string | null;
}): Promise<PasskeyCredentialRecord> {
  initBackend();
  const ts = now();
  const row: PasskeyCredentialRow = {
    id: randomUUID(),
    user_id: params.userId,
    user_handle: params.userHandle,
    rp_id: params.rpId,
    credential_id: params.credentialId,
    public_key_b64: params.publicKeyB64,
    counter: params.counter,
    transports: params.transports ?? null,
    created_at: ts,
    updated_at: ts,
    last_used_at: null,
    revoked_at: null,
  };

  if (useFallback) {
    return withJsonStore((store) => {
      const collision = store.passkeyCredentials.find((entry) => entry.credential_id === params.credentialId);
      if (collision) {
        throw new Error('passkey_credential_collision');
      }
      store.passkeyCredentials.push({ ...row });
      return mapPasskeyCredential(row);
    });
  }

  if (isPostgresBackend) {
    await ensurePostgresSchema();
    try {
      const rows = await queryPostgres<PasskeyCredentialRow>(
        `
          INSERT INTO passkey_credentials (
            id, user_id, user_handle, rp_id, credential_id, public_key_b64, counter, transports, created_at, updated_at, last_used_at, revoked_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
          )
          RETURNING *
        `,
        [
          row.id,
          row.user_id,
          row.user_handle,
          row.rp_id,
          row.credential_id,
          row.public_key_b64,
          row.counter,
          row.transports,
          row.created_at,
          row.updated_at,
          row.last_used_at,
          row.revoked_at,
        ],
      );
      return mapPasskeyCredential(rows[0]!);
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new Error('passkey_credential_collision');
      }
      throw error;
    }
  }

  const database = sqliteDb as SqlDbLike;
  try {
    database
      .prepare(
        `
          INSERT INTO passkey_credentials (
            id, user_id, user_handle, rp_id, credential_id, public_key_b64, counter, transports, created_at, updated_at, last_used_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `,
      )
      .run(
        row.id,
        row.user_id,
        row.user_handle,
        row.rp_id,
        row.credential_id,
        row.public_key_b64,
        row.counter,
        row.transports,
        row.created_at,
        row.updated_at,
      );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      throw new Error('passkey_credential_collision');
    }
    throw error;
  }
  const stored = database
    .prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?')
    .get(params.credentialId) as PasskeyCredentialRow | undefined;
  if (!stored) {
    throw new Error('passkey_credential_not_found');
  }
  return mapPasskeyCredential(stored);
}

export async function getPasskeyCredentialByCredentialId(credentialId: string): Promise<PasskeyCredentialRecord | null> {
  initBackend();
  if (useFallback) {
    const row = readJsonStore().passkeyCredentials.find(
      (entry) => entry.credential_id === credentialId && entry.revoked_at == null,
    ) as PasskeyCredentialRow | undefined;
    if (!row) return null;
    return mapPasskeyCredential(row);
  }

  if (isPostgresBackend) {
    await ensurePostgresSchema();
    const row = await pgGet<PasskeyCredentialRow>(
      'SELECT * FROM passkey_credentials WHERE credential_id = ? AND revoked_at IS NULL',
      [credentialId],
    );
    return row ? mapPasskeyCredential(row) : null;
  }

  const row = (sqliteDb as SqlDbLike)
    .prepare('SELECT * FROM passkey_credentials WHERE credential_id = ? AND revoked_at IS NULL')
    .get(credentialId) as PasskeyCredentialRow | undefined;
  if (!row) return null;
  return mapPasskeyCredential(row);
}

export async function listPasskeyCredentialsForUser(userId: string): Promise<PasskeyCredentialRecord[]> {
  initBackend();
  if (useFallback) {
    return readJsonStore().passkeyCredentials
      .filter((entry) => entry.user_id === userId && entry.revoked_at == null)
      .map((row) => mapPasskeyCredential(row as PasskeyCredentialRow));
  }

  if (isPostgresBackend) {
    await ensurePostgresSchema();
    const rows = await pgAll<PasskeyCredentialRow>(
      'SELECT * FROM passkey_credentials WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at ASC',
      [userId],
    );
    return rows.map(mapPasskeyCredential);
  }

  const rows = (sqliteDb as SqlDbLike)
    .prepare('SELECT * FROM passkey_credentials WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at ASC')
    .all(userId) as PasskeyCredentialRow[];
  return rows.map(mapPasskeyCredential);
}

export async function updatePasskeyCredentialUsage(params: { credentialId: string; counter: number }) {
  initBackend();
  const ts = now();
  if (useFallback) {
    return withJsonStore((store) => {
      const row = store.passkeyCredentials.find(
        (entry) => entry.credential_id === params.credentialId && entry.revoked_at == null,
      ) as PasskeyCredentialRow | undefined;
      if (!row) return null;
      row.counter = params.counter;
      row.last_used_at = ts;
      row.updated_at = ts;
      return row;
    });
  }

  if (isPostgresBackend) {
    await ensurePostgresSchema();
    await execPostgres(
      `
        UPDATE passkey_credentials
        SET counter = $1, last_used_at = $2, updated_at = $2
        WHERE credential_id = $3 AND revoked_at IS NULL
      `,
      [params.counter, ts, params.credentialId],
    );
    return;
  }

  (sqliteDb as SqlDbLike)
    .prepare(
      `
        UPDATE passkey_credentials
        SET counter = ?, last_used_at = ?, updated_at = ?
        WHERE credential_id = ? AND revoked_at IS NULL
      `,
    )
    .run(params.counter, ts, ts, params.credentialId);
}

export function getAuditDropDiagnostics() {
  return auditDropHistory.slice(0, AUDIT_FALLBACK_WINDOW);
}

export async function hasExistingConversation(senderId: string, recipientId: string): Promise<boolean> {
  initBackend();
  if (useFallback) {
    const messages = readJsonStore().messages;
    return messages.some(
      (message) =>
        message.sender_id === senderId &&
        message.recipient_id === recipientId &&
        message.status !== 'failed',
    );
  }
  if (isPostgresBackend) {
    const row = await pgGet<{ count: string | number }>(
      'SELECT COUNT(1) AS count FROM messages WHERE sender_id = ? AND recipient_id = ?',
      [senderId, recipientId],
    );
    return Number(row?.count ?? 0) > 0;
  }

  const row = (sqliteDb as SqlDbLike)
    .prepare('SELECT COUNT(1) AS count FROM messages WHERE sender_id = ? AND recipient_id = ?')
    .get(senderId, recipientId) as { count: number } | undefined;
  return (row?.count ?? 0) > 0;
}

export async function hasRecipientSentToSender(senderId: string, recipientId: string): Promise<boolean> {
  initBackend();
  if (useFallback) {
    const messages = readJsonStore().messages;
    return messages.some(
      (message) =>
        message.sender_id === recipientId &&
        message.recipient_id === senderId &&
        message.status !== 'failed',
    );
  }
  if (isPostgresBackend) {
    const row = await pgGet<{ count: string | number }>(
      'SELECT COUNT(1) AS count FROM messages WHERE sender_id = ? AND recipient_id = ?',
      [recipientId, senderId],
    );
    return Number(row?.count ?? 0) > 0;
  }
  const row = (sqliteDb as SqlDbLike)
      .prepare('SELECT COUNT(1) AS count FROM messages WHERE sender_id = ? AND recipient_id = ?')
      .get(recipientId, senderId) as { count: number } | undefined;
  return (row?.count ?? 0) > 0;
}

export async function auditLog(userId: string, eventType: string, metadata: Record<string, any>) {
  initBackend();
  const record = {
    id: randomUUID(),
    userId,
    eventType,
    eventAt: now(),
    metadata: JSON.stringify(metadata),
  };
  try {
    if (useFallback) {
      withJsonStore((store) => {
        store.vaultAuditLog.push({
          id: record.id,
          user_id: record.userId,
          event_type: record.eventType,
          event_at: record.eventAt,
          metadata_json: record.metadata,
        });
      });
      return;
    }

    if (isPostgresBackend) {
      await execPostgres(
        'INSERT INTO vault_audit_log (id, user_id, event_type, event_at, metadata_json) VALUES ($1, $2, $3, $4, $5)',
        [record.id, record.userId, record.eventType, record.eventAt, record.metadata],
      );
      return;
    }

    (sqliteDb as SqlDbLike)
      .prepare(
        'INSERT INTO vault_audit_log (id, user_id, event_type, event_at, metadata_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.id, record.userId, record.eventType, record.eventAt, record.metadata);
  } catch (error) {
    trackAuditDrop(userId, eventType, error instanceof Error ? error.message : String(error), metadata);
  }
}

export type VaultBlobRecord = {
  user_id: string;
  blob_json: string;
  version: number;
  created_at: number;
  updated_at: number;
};

export async function upsertVaultBlob(userId: string, blobJson: string, version = 1): Promise<VaultBlobRecord> {
  initBackend();
  const ts = now();
  const safeVersion = Number.isFinite(version) && version > 0 ? Math.floor(version) : 1;

  if (useFallback) {
    return withJsonStore((store) => {
      const existing = store.vaultBlobs.find((row) => row.user_id === userId) as any | undefined;
      if (existing) {
        existing.blob_json = blobJson;
        existing.version = safeVersion;
        existing.updated_at = ts;
        return existing as VaultBlobRecord;
      }
      const row = {
        user_id: userId,
        blob_json: blobJson,
        version: safeVersion,
        created_at: ts,
        updated_at: ts,
      };
      store.vaultBlobs.push(row);
      return row as VaultBlobRecord;
    });
  }

  if (isPostgresBackend) {
    await ensurePostgresSchema();
    await execPostgres(
      `
        INSERT INTO vault_blobs (user_id, blob_json, version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET
          blob_json = EXCLUDED.blob_json,
          version = EXCLUDED.version,
          updated_at = EXCLUDED.updated_at
      `,
      [userId, blobJson, safeVersion, ts, ts],
    );
    const row = await pgGet<VaultBlobRecord>('SELECT user_id, blob_json, version, created_at, updated_at FROM vault_blobs WHERE user_id = ?', [userId]);
    return row as VaultBlobRecord;
  }

  const database = sqliteDb as SqlDbLike;
  database
    .prepare(
      `
        INSERT INTO vault_blobs (user_id, blob_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          blob_json=excluded.blob_json,
          version=excluded.version,
          updated_at=excluded.updated_at
      `,
    )
    .run(userId, blobJson, safeVersion, ts, ts);
  return database
    .prepare('SELECT user_id, blob_json, version, created_at, updated_at FROM vault_blobs WHERE user_id = ?')
    .get(userId) as VaultBlobRecord;
}

export async function getVaultBlob(userId: string): Promise<VaultBlobRecord | null> {
  initBackend();
  if (useFallback) {
    return (readJsonStore().vaultBlobs.find((row) => row.user_id === userId) as VaultBlobRecord | undefined) ?? null;
  }
  if (isPostgresBackend) {
    await ensurePostgresSchema();
    const row = await pgGet<VaultBlobRecord>(
      'SELECT user_id, blob_json, version, created_at, updated_at FROM vault_blobs WHERE user_id = ?',
      [userId],
    );
    return row ?? null;
  }
  const row = (sqliteDb as SqlDbLike)
    .prepare('SELECT user_id, blob_json, version, created_at, updated_at FROM vault_blobs WHERE user_id = ?')
    .get(userId) as VaultBlobRecord | undefined;
  return row ?? null;
}

export async function deleteVaultBlob(userId: string): Promise<boolean> {
  initBackend();
  if (useFallback) {
    return withJsonStore((store) => {
      const before = store.vaultBlobs.length;
      store.vaultBlobs = store.vaultBlobs.filter((row) => row.user_id !== userId);
      return store.vaultBlobs.length !== before;
    });
  }
  if (isPostgresBackend) {
    await ensurePostgresSchema();
    const result = await queryPostgres<{ count: string | number }>(
      `
        WITH deleted AS (
          DELETE FROM vault_blobs WHERE user_id = $1 RETURNING 1
        )
        SELECT COUNT(1) AS count FROM deleted
      `,
      [userId],
    );
    return Number(result[0]?.count ?? 0) > 0;
  }
  const database = sqliteDb as SqlDbLike;
  const result = database.prepare('DELETE FROM vault_blobs WHERE user_id = ?').run(userId);
  return result.changes > 0;
}

export type AbuseKeyType = 'sender' | 'recipient' | 'ip' | 'device';

export type AbuseBlockRecord = {
  keyType: AbuseKeyType;
  keyValue: string;
  blockedUntil: number;
  reason: string;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
};

export async function getActiveAbuseBlock(keyType: AbuseKeyType, keyValue: string): Promise<AbuseBlockRecord | null> {
  initBackend();
  if (!keyValue) return null;
  const nowTs = now();

  if (useFallback) {
    const row =
      readJsonStore().abuseBlocks.find(
        (item) => item.key_type === keyType && item.key_value === keyValue && toNumber(item.blocked_until)! > nowTs,
      ) ?? null;
    if (!row) return null;
    return {
      keyType: row.key_type,
      keyValue: row.key_value,
      blockedUntil: toNumber(row.blocked_until) ?? 0,
      reason: row.reason ?? 'unknown',
      metadataJson: toNullableString(row.metadata_json),
      createdAt: toNumber(row.created_at) ?? 0,
      updatedAt: toNumber(row.updated_at) ?? 0,
    };
  }

  if (isPostgresBackend) {
    const row = await pgGet<DbRow>(
      'SELECT key_type, key_value, blocked_until, reason, metadata_json, created_at, updated_at FROM abuse_blocks WHERE key_type = ? AND key_value = ? AND blocked_until > ?',
      [keyType, keyValue, nowTs],
    );
    if (!row) return null;
    return {
      keyType: row.key_type,
      keyValue: row.key_value,
      blockedUntil: Number(row.blocked_until),
      reason: row.reason,
      metadataJson: toNullableString(row.metadata_json),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  const row = (sqliteDb as SqlDbLike)
    .prepare(
      'SELECT key_type, key_value, blocked_until, reason, metadata_json, created_at, updated_at FROM abuse_blocks WHERE key_type = ? AND key_value = ? AND blocked_until > ?',
    )
    .get(keyType, keyValue, nowTs) as DbRow | undefined;
  if (!row) return null;
  return {
    keyType: row.key_type,
    keyValue: row.key_value,
    blockedUntil: toNumber(row.blocked_until) ?? 0,
    reason: row.reason ?? 'unknown',
    metadataJson: toNullableString(row.metadata_json),
    createdAt: toNumber(row.created_at) ?? 0,
    updatedAt: toNumber(row.updated_at) ?? 0,
  };
}

export async function upsertAbuseBlock(record: {
  keyType: AbuseKeyType;
  keyValue: string;
  blockedUntil: number;
  reason: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  initBackend();
  if (!record.keyValue) return;
  const ts = now();
  const metadataJson = record.metadata ? JSON.stringify(record.metadata) : null;

  if (useFallback) {
    withJsonStore((store) => {
      const existing = store.abuseBlocks.find(
        (item) => item.key_type === record.keyType && item.key_value === record.keyValue,
      );
      if (existing) {
        existing.blocked_until = Math.max(
          toNumber(existing.blocked_until) ?? 0,
          Number.isFinite(record.blockedUntil) ? record.blockedUntil : 0,
        );
        existing.reason = record.reason;
        existing.metadata_json = metadataJson;
        existing.updated_at = ts;
        return;
      }
      store.abuseBlocks.push({
        key_type: record.keyType,
        key_value: record.keyValue,
        blocked_until: record.blockedUntil,
        reason: record.reason,
        metadata_json: metadataJson,
        created_at: ts,
        updated_at: ts,
      });
    });
    return;
  }

  if (isPostgresBackend) {
    await execPostgres(
      `
        INSERT INTO abuse_blocks
          (key_type, key_value, blocked_until, reason, metadata_json, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (key_type, key_value) DO UPDATE SET
          blocked_until = GREATEST(abuse_blocks.blocked_until, EXCLUDED.blocked_until),
          reason = EXCLUDED.reason,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = EXCLUDED.updated_at
      `,
      [record.keyType, record.keyValue, record.blockedUntil, record.reason, metadataJson, ts],
    );
    return;
  }

  (sqliteDb as SqlDbLike)
    .prepare(
      `
        INSERT INTO abuse_blocks
          (key_type, key_value, blocked_until, reason, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_type, key_value) DO UPDATE SET
          blocked_until = max(abuse_blocks.blocked_until, excluded.blocked_until),
          reason = excluded.reason,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
    )
    .run(record.keyType, record.keyValue, record.blockedUntil, record.reason, metadataJson, ts, ts);
}

export async function incrementAbuseCounter(record: {
  keyType: AbuseKeyType;
  keyValue: string;
  windowStart: number;
  delta?: number;
}): Promise<number> {
  initBackend();
  if (!record.keyValue) return 0;

  const ts = now();
  const delta = Number.isFinite(record.delta) ? Math.max(1, record.delta as number) : 1;

  if (useFallback) {
    let next = 0;
    withJsonStore((store) => {
      const existing = store.abuseCounters.find(
        (item) =>
          item.key_type === record.keyType &&
          item.key_value === record.keyValue &&
          toNumber(item.window_start) === record.windowStart,
      );
      if (existing) {
        existing.count = (toNumber(existing.count) ?? 0) + delta;
        existing.updated_at = ts;
        next = toNumber(existing.count) ?? 0;
        return;
      }
      const initial = delta;
      store.abuseCounters.push({
        key_type: record.keyType,
        key_value: record.keyValue,
        window_start: record.windowStart,
        count: initial,
        created_at: ts,
        updated_at: ts,
      });
      next = initial;
    });
    return next;
  }

  if (isPostgresBackend) {
    const result = await execPostgres(
      `
        INSERT INTO abuse_counters
          (key_type, key_value, window_start, count, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (key_type, key_value, window_start) DO UPDATE SET
          count = abuse_counters.count + EXCLUDED.count,
          updated_at = EXCLUDED.updated_at
        RETURNING count
      `,
      [record.keyType, record.keyValue, record.windowStart, delta, ts],
    );
    const row = (result.rows?.[0] as { count?: number | string } | undefined) ?? null;
    return Number(row?.count ?? 0);
  }

  const row = (sqliteDb as SqlDbLike)
    .prepare(
      `
        INSERT INTO abuse_counters
          (key_type, key_value, window_start, count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_type, key_value, window_start) DO UPDATE SET
          count = abuse_counters.count + excluded.count,
          updated_at = excluded.updated_at
        RETURNING count
      `,
    )
    .get(record.keyType, record.keyValue, record.windowStart, delta, ts, ts) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

export async function recordAbuseEvent(record: {
  action: string;
  decision: string;
  score: number;
  senderId?: string | null;
  recipientId?: string | null;
  ipKey?: string | null;
  deviceKey?: string | null;
  windowStart: number;
  createdAt?: number;
  reason?: string | null;
  details?: Record<string, any>;
}) {
  initBackend();
  const id = randomUUID();
  const createdAt = Number.isFinite(record.createdAt) ? (record.createdAt as number) : now();
  const detailsJson = record.details ? JSON.stringify(record.details) : null;

  if (useFallback) {
    withJsonStore((store) => {
      store.abuseEvents.push({
        id,
        action: record.action,
        decision: record.decision,
        score: record.score,
        sender_id: record.senderId ?? null,
        recipient_id: record.recipientId ?? null,
        ip_key: record.ipKey ?? null,
        device_key: record.deviceKey ?? null,
        window_start: record.windowStart,
        created_at: createdAt,
        reason: record.reason ?? null,
        details_json: detailsJson,
      });
    });
    return;
  }

  if (isPostgresBackend) {
    await execPostgres(
      `
        INSERT INTO abuse_events
          (id, action, decision, score, sender_id, recipient_id, ip_key, device_key, window_start, created_at, reason, details_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        id,
        record.action,
        record.decision,
        record.score,
        record.senderId ?? null,
        record.recipientId ?? null,
        record.ipKey ?? null,
        record.deviceKey ?? null,
        record.windowStart,
        createdAt,
        record.reason ?? null,
        detailsJson,
      ],
    );
    return;
  }

  (sqliteDb as SqlDbLike)
    .prepare(
      `
        INSERT INTO abuse_events
          (id, action, decision, score, sender_id, recipient_id, ip_key, device_key, window_start, created_at, reason, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      record.action,
      record.decision,
      record.score,
      record.senderId ?? null,
      record.recipientId ?? null,
      record.ipKey ?? null,
      record.deviceKey ?? null,
      record.windowStart,
      createdAt,
      record.reason ?? null,
      detailsJson,
    );
}

initBackend();
