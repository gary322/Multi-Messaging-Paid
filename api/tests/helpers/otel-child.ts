import request from 'supertest';
import { createServer } from '../../src/index';

async function main() {
  const app = await createServer();
  await request(app.server).get('/health');
  await app.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

