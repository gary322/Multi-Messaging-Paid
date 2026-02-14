import { createHmac } from 'node:crypto';
import { Wallet } from 'ethers';
import { env } from '../config/env';

export type SmartAccountInput = {
  provider: string;
  subject: string;
};

export function deriveSmartWalletAddress(input: SmartAccountInput) {
  // This is a *local-only* deterministic wallet mapping used when no remote verifier is configured.
  // It must be keyed (HMAC) so that wallet addresses/keys are not derivable from public identifiers.
  const namespace = `${env.PASSKEY_SOCIAL_NAMESPACE || 'mmp'}:${input.provider}`.toLowerCase();
  const seed = `${namespace}:${input.subject}`;
  const hmacKey = String(env.SMART_ACCOUNT_DERIVATION_KEY || env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET);
  const hash = createHmac('sha256', hmacKey).update(seed).digest('hex');
  const key = `0x${hash}`;
  const wallet = new Wallet(key);
  return wallet.address.toLowerCase();
}
