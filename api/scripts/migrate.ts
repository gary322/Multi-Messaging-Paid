import { env } from '../src/config/env';
import { migratePostgresSchema } from '../src/lib/db';
import { closePostgresPool } from '../src/lib/postgres';

async function main() {
  if (env.DATABASE_BACKEND !== 'postgres') {
    console.error('MIGRATION_SKIPPED: DATABASE_BACKEND is not postgres');
    process.exitCode = 0;
    return;
  }

  if (!env.DATABASE_URL) {
    console.error('MIGRATION_FAILED: DATABASE_URL is required for postgres migrations');
    process.exitCode = 1;
    return;
  }

  try {
    await migratePostgresSchema();
    console.log('MIGRATION_OK: postgres schema is ready');
  } catch (error) {
    console.error('MIGRATION_FAILED:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await closePostgresPool();
  }
}

void main();
