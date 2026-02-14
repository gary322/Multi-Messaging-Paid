import { createUser, getIdentityBinding, resetStore, saveIdentityBinding } from '../src/lib/db';

describe('identity bindings persistence', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('stores and reads identity binding records', async () => {
    const user = await createUser('0x1111111111111111111111111111111111111111');
    const walletAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    await saveIdentityBinding({
      walletAddress,
      method: 'social',
      provider: 'google',
      subject: 'social-user-1',
      userId: user.id,
    });

    const binding = await getIdentityBinding('social', 'google', 'social-user-1');
    expect(binding).toBeTruthy();
    expect(binding?.walletAddress).toBe(walletAddress);
    expect(binding?.method).toBe('social');
  });

  it('rejects identity-wallet collision across providers/subjects while keeping existing binding', async () => {
    const firstUser = await createUser('0x1111111111111111111111111111111111111111');
    const secondUser = await createUser('0x2222222222222222222222222222222222222222');
    const sharedWallet = '0xcccccccccccccccccccccccccccccccccccccccc';

    await saveIdentityBinding({
      walletAddress: sharedWallet,
      method: 'social',
      provider: 'google',
      subject: 'social-subject',
      userId: firstUser.id,
    });

    await expect(
      saveIdentityBinding({
        walletAddress: sharedWallet,
        method: 'passkey',
        provider: 'apple',
        subject: 'passkey-subject',
        userId: secondUser.id,
      }),
    ).rejects.toThrow('identity_wallet_collision');
  });
});
