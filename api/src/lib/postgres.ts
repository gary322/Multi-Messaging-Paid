import { Pool, type PoolClient } from 'pg';
import { env } from '../config/env';

type QueryParams = unknown[];

let pool: Pool | null = null;
let closeInProgress: Promise<void> | null = null;
let isClosing = false;
let leasedClientCount = 0;
let activeQueryCount = 0;
const POOL_CLOSE_TIMEOUT_MS = 2_000;

function isPostgresConfigured() {
  return Boolean(env.DATABASE_URL);
}

function createPool() {
  if (!isPostgresConfigured()) {
    return null;
  }

  const p = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: env.DATABASE_POOL_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
  });
  return p;
}

export function getPostgresPool(): Pool | null {
  if (isClosing) {
    return null;
  }
  if (pool) return pool;
  pool = createPool();
  return pool;
}

async function waitForPendingPoolActivity() {
  if (leasedClientCount <= 0 && activeQueryCount <= 0) return;
  const start = Date.now();
  while (
    (leasedClientCount > 0 || activeQueryCount > 0) &&
    Date.now() - start < POOL_CLOSE_TIMEOUT_MS
  ) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20);
      timer.unref();
    });
  }
}

function markPoolCloseComplete() {
  closeInProgress = null;
  isClosing = false;
}

export async function closePostgresPool() {
  if (isClosing) {
    return closeInProgress ?? Promise.resolve();
  }
  if (!pool) {
    return Promise.resolve();
  }

  isClosing = true;
  const current = pool;
  pool = null;

  closeInProgress = (async () => {
    try {
      await waitForPendingPoolActivity();
      await current.end();
    } finally {
      markPoolCloseComplete();
    }
  })();

  return closeInProgress;
}

export function isPostgresEnabled() {
  return Boolean(env.DATABASE_URL) && env.DATABASE_BACKEND === 'postgres';
}

export async function withPostgresClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const p = getPostgresPool();
  if (!p) {
    throw new Error('Postgres pool is not configured');
  }
  leasedClientCount += 1;
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    leasedClientCount -= 1;
    client.release();
  }
}

export async function queryPostgres<T = Record<string, unknown>>(
  text: string,
  params: QueryParams = [],
): Promise<T[]> {
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error('Postgres pool is not configured');
  }
  activeQueryCount += 1;
  try {
    const result = await pool.query(text, params);
    return result.rows as T[];
  } finally {
    activeQueryCount -= 1;
  }
}

export async function execPostgres(text: string, params: QueryParams = []) {
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error('Postgres pool is not configured');
  }
  activeQueryCount += 1;
  try {
    const result = await pool.query(text, params);
    return result;
  } finally {
    activeQueryCount -= 1;
  }
}
