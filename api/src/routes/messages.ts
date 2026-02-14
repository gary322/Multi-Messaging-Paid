import { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'crypto';
import { Wallet } from 'ethers';
import { z } from 'zod';
import {
  auditLog,
  changeBalance,
  setBalance,
  createMessage,
  getMessageByMessageId,
  hasExistingConversation,
  getMessageIdByIdempotency,
  saveMessageIdempotency,
  hasRecipientSentToSender,
  getPricing,
  getInbox,
  getUserById,
  findUserByHandle,
  findUserByPhone,
  updateMessageStatus,
  queueNotificationJobsForMessage,
} from '../lib/db';
import { checkMessageSendAbuse } from '../lib/abuse';
import { checkRateLimit } from '../lib/rateLimit';
import { requireAuthUser } from '../lib/auth';
import { requireLaunchReady } from '../lib/complianceGuard';
import { env } from '../config/env';
import { getCustodialPrivateKeyForUser } from '../lib/custodialWallet';
import {
  isChainConfigured,
  isValidChainAddress,
  normalizeChainAmount,
  readChainBalance,
  sendOnChainPayment,
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

  app.post('/v1/messages/send', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const result = await checkRateLimit(req);
    if (result.error) {
      reply.status(503).send({ error: result.error });
      return;
    }
    if (!result.ok) {
      reply.status(429).send({ error: 'rate_limited' });
      return;
    }

    const body = z
      .object({
        senderId: z.string().min(1),
        recipientSelector: z.string().min(3),
        plaintext: z.string().min(1),
        idempotencyKey: z.string().trim().max(255).optional(),
        senderPrivateKey: z.string().optional(),
      })
      .parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.senderId);
    if (!authedUserId) return;

    const sender = await getUserById(authedUserId);
    if (!sender) {
      reply.status(404).send({ error: 'sender_not_found' });
      return;
    }

    const recipientSelector = body.recipientSelector.trim();
    const normalizedHandle = recipientSelector.startsWith('@')
      ? recipientSelector.slice(1)
      : recipientSelector;
    const recipient =
      (await findUserByHandle(normalizedHandle, false)) || (await findUserByPhone(recipientSelector, true));

    if (!recipient) {
      reply.status(404).send({ error: 'recipient_not_found' });
      return;
    }

    if (recipient.id === sender.id) {
      reply.status(409).send({ error: 'self_send_not_allowed' });
      return;
    }

    const idempotencyKey = body.idempotencyKey?.trim();
    if (idempotencyKey) {
      const existingMessageId = await getMessageIdByIdempotency(sender.id, idempotencyKey);
      if (existingMessageId) {
        const existingMessage = await getMessageByMessageId(existingMessageId);
        if (existingMessage) {
          if (existingMessage.recipient_id !== recipient.id) {
            reply.status(409).send({ error: 'idempotency_conflict', reason: 'Different recipient for idempotency key' });
            return;
          }
          reply.send({
            messageId: existingMessage.message_id,
            paid: existingMessage.price,
            recipient: recipient.wallet_address,
            status: existingMessage.status,
            txHash: existingMessage.tx_hash ?? null,
          });
          return;
        }
      }
    }

    const abuse = await checkMessageSendAbuse(req, { senderId: sender.id, recipientId: recipient.id });
    if (!abuse.ok) {
      const retryAfterSeconds = Math.max(1, Math.ceil(abuse.retryAfterMs / 1000));
      reply.header('Retry-After', String(retryAfterSeconds));
      reply.status(429).send({
        error: 'abuse_blocked',
        blockedUntil: abuse.blockedUntil,
        retryAfterMs: abuse.retryAfterMs,
      });
      return;
    }

    const pricing = await getPricing(recipient.id);
    const basePrice = Number(pricing?.default_price ?? 200);
    const firstContactPrice = Number(pricing?.first_contact_price ?? basePrice);
    const discountBps = Number(pricing?.return_discount_bps ?? 0);

    const hasPriorFromSenderToRecipient = await hasExistingConversation(sender.id, recipient.id);
    const hasReturn = await hasRecipientSentToSender(sender.id, recipient.id);
    let price = hasPriorFromSenderToRecipient ? basePrice : firstContactPrice;
    if (hasPriorFromSenderToRecipient && hasReturn && discountBps > 0 && discountBps < 10_000) {
      price = Math.max(0, Math.floor(price - Math.floor((price * discountBps) / 10_000)));
    }

    if (Number(sender.balance) < price) {
      reply.status(402).send({ error: 'insufficient_balance', required: price });
      return;
    }

    const nonce = randomBytes(12).toString('hex');
    const messageId = createHash('sha256').update(`${sender.id}-${recipient.id}-${nonce}`).digest('hex');
    const contentHash = createHash('sha256').update(body.plaintext).digest('hex');
    const chainMessageId = `0x${messageId}`;
    const chainContentHash = `0x${contentHash}`;
    const chainAmount = normalizeChainAmount(price, env.CHAIN_TOKEN_DECIMALS);

    if (body.senderPrivateKey && env.NODE_ENV === 'production' && !env.ALLOW_UNSAFE_PRIVATE_KEY_INPUT) {
      reply.status(400).send({ error: 'unsafe_private_key_input_disabled' });
      return;
    }

    const signerKey =
      body.senderPrivateKey ||
      (await getCustodialPrivateKeyForUser(sender.id)) ||
      env.CHAIN_PAYER_PRIVATE_KEY;
    const useChain =
      (await isChainConfigured(env.CHAIN_RPC_URL, env.CHAIN_VAULT_ADDRESS)) &&
      isValidChainAddress(env.CHAIN_VAULT_ADDRESS) &&
      isValidChainAddress(recipient.wallet_address) &&
      isValidChainAddress(sender.wallet_address);
    const canUseChain = useChain && isSignerForUser(sender.wallet_address, signerKey);
    if (canUseChain) {
      if (!signerKey) {
        reply.status(400).send({
          error: 'chain_private_key_required',
          reason: 'Set CHAIN_PAYER_PRIVATE_KEY or pass senderPrivateKey',
        });
        return;
      }
      const txHash = await sendOnChainPayment({
        rpcUrl: env.CHAIN_RPC_URL,
        privateKey: signerKey,
        contractAddress: env.CHAIN_VAULT_ADDRESS,
        recipient: recipient.wallet_address,
        messageId: chainMessageId,
        contentHash: chainContentHash,
        channel: env.CHAIN_MESSAGE_CHANNEL || 1,
        amount: chainAmount,
      });

      const senderBalance = await readChainBalance(
        env.CHAIN_RPC_URL,
        env.CHAIN_VAULT_ADDRESS,
        sender.wallet_address,
        env.CHAIN_TOKEN_DECIMALS,
      );
      const recipientBalance = await readChainBalance(
        env.CHAIN_RPC_URL,
        env.CHAIN_VAULT_ADDRESS,
        recipient.wallet_address,
        env.CHAIN_TOKEN_DECIMALS,
      );
      if (senderBalance !== null) {
        await setBalance(sender.id, senderBalance);
      }
      if (recipientBalance !== null) {
        await setBalance(recipient.id, recipientBalance);
      }

      await createMessage({
        messageId,
        senderId: sender.id,
        recipientId: recipient.id,
        ciphertext: `encrypted:${Buffer.from(body.plaintext).toString('base64')}`,
        contentHash,
        price,
        status: 'paid',
        txHash,
      });

      await updateMessageStatus(messageId, 'delivered', txHash);
      await auditLog(sender.id, 'message_send', {
        messageId,
        recipientId: recipient.id,
        price,
        txHash,
      });
      await auditLog(recipient.id, 'message_received', {
        messageId,
        senderId: sender.id,
        price,
        txHash,
      });

      if (idempotencyKey) {
        await saveMessageIdempotency(sender.id, idempotencyKey, messageId);
      }

      await queueNotificationJobsForMessage({
        messageId,
        recipientId: recipient.id,
        recipientWallet: recipient.wallet_address,
        price,
        txHash,
      });

      reply.send({
        messageId,
        paid: price,
        recipient: recipient.wallet_address,
        status: 'delivered',
        txHash,
      });
      return;
    }

    await changeBalance(sender.id, -price);
    await changeBalance(recipient.id, price);
    await createMessage({
      messageId,
      senderId: sender.id,
      recipientId: recipient.id,
      ciphertext: `encrypted:${Buffer.from(body.plaintext).toString('base64')}`,
      contentHash,
      price,
      status: 'paid',
      txHash: null,
    });

    await updateMessageStatus(messageId, 'delivered');
    await auditLog(sender.id, 'message_send', {
      messageId,
      recipientId: recipient.id,
      price,
      txHash: null,
    });
    await auditLog(recipient.id, 'message_received', {
      messageId,
      senderId: sender.id,
      price,
    });

      await queueNotificationJobsForMessage({
        messageId,
        recipientId: recipient.id,
        recipientWallet: recipient.wallet_address,
        price,
        txHash: null,
    });

    if (idempotencyKey) {
      await saveMessageIdempotency(sender.id, idempotencyKey, messageId);
    }

    reply.send({ messageId, paid: price, recipient: recipient.wallet_address, status: 'delivered' });
  });

  app.get('/v1/messages/inbox/:recipientId', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const params = z.object({ recipientId: z.string().min(1) }).parse(req.params);
    const authedUserId = requireAuthUser(req, reply, params.recipientId);
    if (!authedUserId) return;

    const rows = await getInbox(params.recipientId);
    reply.send({ messages: rows });
  });
}
