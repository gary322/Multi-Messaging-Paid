import { closeChainClients } from '../src/services/chain';
import { closePostgresPool } from '../src/lib/postgres';
import { closeRedisClient } from '../src/lib/redis';
import { shutdownOtelTracing } from '../src/lib/otel';

export default async function () {
  await shutdownOtelTracing();
  await closePostgresPool();
  await closeRedisClient();
  await closeChainClients();
}
