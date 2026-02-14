import { env } from '../config/env';
import { getCustodialWallet, getUserById } from './db';
import { decryptSecret } from './vault';

type EncryptedEnvelope = {
  ciphertext: string;
  iv: string;
  tag: string;
};

function safeParseEnvelope(raw: string): EncryptedEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EncryptedEnvelope>;
    if (!parsed?.ciphertext || !parsed.iv || !parsed.tag) {
      return null;
    }
    return { ciphertext: parsed.ciphertext, iv: parsed.iv, tag: parsed.tag };
  } catch {
    return null;
  }
}

export async function getCustodialPrivateKeyForUser(userId: string): Promise<string | null> {
  if (!env.CUSTODIAL_WALLET_SIGNING_ENABLED) {
    return null;
  }

  const record = await getCustodialWallet(userId);
  if (!record) {
    return null;
  }

  const envelope = safeParseEnvelope(record.encryptedPrivateKeyJson);
  if (!envelope) {
    throw new Error('custodial_wallet_envelope_invalid');
  }

  const privateKey = decryptSecret(envelope);
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) {
    throw new Error('custodial_wallet_private_key_invalid');
  }

  const user = await getUserById(userId);
  if (user && user.wallet_address && user.wallet_address.toLowerCase() !== record.walletAddress.toLowerCase()) {
    throw new Error('custodial_wallet_address_mismatch');
  }

  return privateKey;
}

