import { closeChainClients } from '../src/services/chain';
import { closePostgresPool } from '../src/lib/postgres';
import { closeRedisClient } from '../src/lib/redis';
import { shutdownOtelTracing } from '../src/lib/otel';

afterAll(async () => {
  // Some integration-style tests touch postgres/redis directly without creating a Fastify server.
  // Ensure we close shared clients between test files so Jest can exit cleanly.
  await shutdownOtelTracing();
  await closePostgresPool();
  await closeRedisClient();
  await closeChainClients();
});
