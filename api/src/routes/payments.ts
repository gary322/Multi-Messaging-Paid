import { FastifyInstance } from 'fastify';
import { Wallet } from 'ethers';
import { z } from 'zod';
import { auditLog, changeBalance, getUserById, setBalance } from '../lib/db';
import { requireAuthUser } from '../lib/auth';
import { requireLaunchReady } from '../lib/complianceGuard';
import { env } from '../config/env';
import { getCustodialPrivateKeyForUser } from '../lib/custodialWallet';
import {
  isChainConfigured,
  isValidChainAddress,
  normalizeChainAmount,
  readChainBalance,
  topupOnChainVault,
  withdrawFromVault,
} from '../services/chain';

export default async function (app: FastifyInstance) {
  const isSignerForUser = (walletAddress: string, privateKey?: string) => {
    if (!privateKey) return false;
    try {
      const signer = new Wallet(privateKey);
      return signer.address.toLowerCase() === walletAddress.toLowerCase();
    } catch {
      return false;
    }
  };

  app.post('/v1/payments/topup', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z
      .object({
        userId: z.string().min(1),
        amount: z.number().int().min(1),
        privateKey: z.string().optional(),
      })
      .parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const user = await getUserById(authedUserId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }

    if (body.privateKey && env.NODE_ENV === 'production' && !env.ALLOW_UNSAFE_PRIVATE_KEY_INPUT) {
      reply.status(400).send({ error: 'unsafe_private_key_input_disabled' });
      return;
    }

    const useChain = await isChainConfigured(env.CHAIN_RPC_URL, env.CHAIN_VAULT_ADDRESS);
    const signerKey =
      body.privateKey ||
      (await getCustodialPrivateKeyForUser(user.id)) ||
      env.CHAIN_PAYER_PRIVATE_KEY;
    const chainModeTopup =
      useChain &&
      !!env.CHAIN_USDC_ADDRESS &&
      isValidChainAddress(env.CHAIN_USDC_ADDRESS) &&
      isValidChainAddress(env.CHAIN_VAULT_ADDRESS) &&
      isValidChainAddress(user.wallet_address);
    const canUseChainTopup = chainModeTopup && isSignerForUser(user.wallet_address, signerKey);
    if (canUseChainTopup) {
      if (!signerKey) {
        reply.status(400).send({
          error: 'chain_private_key_required',
          reason: 'Set CHAIN_PAYER_PRIVATE_KEY or pass privateKey',
        });
        return;
      }

      const chainAmount = normalizeChainAmount(body.amount, env.CHAIN_TOKEN_DECIMALS);
      await topupOnChainVault({
        rpcUrl: env.CHAIN_RPC_URL,
        privateKey: signerKey,
        tokenAddress: env.CHAIN_USDC_ADDRESS,
        vaultAddress: env.CHAIN_VAULT_ADDRESS,
        amount: chainAmount,
      });
      const updatedBalance = await readChainBalance(
        env.CHAIN_RPC_URL,
        env.CHAIN_VAULT_ADDRESS,
        user.wallet_address,
        env.CHAIN_TOKEN_DECIMALS,
      );
      if (updatedBalance !== null) {
        await setBalance(authedUserId, updatedBalance);
        await auditLog(authedUserId, 'topup', { amount: body.amount, mode: 'onchain' });
        reply.send({ balance: Number(updatedBalance), userId: body.userId, mode: 'onchain' });
        return;
      }
    }

    const updated = await changeBalance(authedUserId, body.amount);
    await auditLog(authedUserId, 'topup', { amount: body.amount, mode: 'simulated' });
    reply.send({ balance: Number(updated.balance), userId: body.userId });
  });

  app.post('/v1/payments/withdraw', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z
      .object({
        userId: z.string().min(1),
        amount: z.number().int().min(1),
        privateKey: z.string().optional(),
      })
      .parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const user = await getUserById(authedUserId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }
    if (user.balance < body.amount) {
      reply.status(409).send({ error: 'insufficient_balance' });
      return;
    }

    const useChain = await isChainConfigured(env.CHAIN_RPC_URL, env.CHAIN_VAULT_ADDRESS);
    if (body.privateKey && env.NODE_ENV === 'production' && !env.ALLOW_UNSAFE_PRIVATE_KEY_INPUT) {
      reply.status(400).send({ error: 'unsafe_private_key_input_disabled' });
      return;
    }

    const signerKey =
      body.privateKey ||
      (await getCustodialPrivateKeyForUser(user.id)) ||
      env.CHAIN_PAYER_PRIVATE_KEY;
    const canUseChainWithdraw =
      useChain &&
      isValidChainAddress(env.CHAIN_VAULT_ADDRESS) &&
      isValidChainAddress(user.wallet_address) &&
      isSignerForUser(user.wallet_address, signerKey);
    if (canUseChainWithdraw) {
      if (!signerKey) {
        reply.status(400).send({
          error: 'chain_private_key_required',
          reason: 'Set CHAIN_PAYER_PRIVATE_KEY or pass privateKey',
        });
        return;
      }

      const chainAmount = normalizeChainAmount(body.amount, env.CHAIN_TOKEN_DECIMALS);
      await withdrawFromVault({
        rpcUrl: env.CHAIN_RPC_URL,
        privateKey: signerKey,
        vaultAddress: env.CHAIN_VAULT_ADDRESS,
        amount: chainAmount,
      });

      const updatedBalance = await readChainBalance(
        env.CHAIN_RPC_URL,
        env.CHAIN_VAULT_ADDRESS,
        user.wallet_address,
        env.CHAIN_TOKEN_DECIMALS,
      );
      if (updatedBalance !== null) {
        await setBalance(authedUserId, updatedBalance);
        await auditLog(authedUserId, 'withdraw', { amount: body.amount, mode: 'onchain' });
        reply.send({ balance: Number(updatedBalance), userId: body.userId });
        return;
      }
    }

    const updated = await changeBalance(authedUserId, -body.amount);
    await auditLog(authedUserId, 'withdraw', { amount: body.amount });
    reply.send({ balance: Number(updated.balance), userId: body.userId });
  });
}
