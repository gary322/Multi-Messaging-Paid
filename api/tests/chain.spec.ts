import { buildReadOnlyProvider, readChainBalance } from '../src/services/chain';
import { closeChainClients } from '../src/services/chain';

describe('chain service', () => {
  afterEach(() => {
    return closeChainClients();
  });

  it('keeps fallback when no rpc', async () => {
    const p = await buildReadOnlyProvider();
    expect(p).toBeNull();
  });

  it('caches provider instances per rpc url', async () => {
    const first = await buildReadOnlyProvider('http://node-a.test');
    const second = await buildReadOnlyProvider('http://node-a.test');
    const third = await buildReadOnlyProvider('http://node-b.test');

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });

  it('returns null when balance endpoint has no rpc', async () => {
    const res = await readChainBalance('', '', '');
    expect(res).toBeNull();
  });
});
