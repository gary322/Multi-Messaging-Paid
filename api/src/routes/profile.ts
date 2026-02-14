import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditLog, findUserByHandle, findUserByPhone, getPricing, setPricing, updateUser, getUserById } from '../lib/db';
import { requireAuthUser } from '../lib/auth';
import { requireLaunchReady } from '../lib/complianceGuard';
import { env } from '../config/env';
import { isValidHandle, normalizeHandle } from '../lib/handles';

export default async function (app: FastifyInstance) {
  app.get('/v1/identity/:handle', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const params = z.object({ handle: z.string().min(3).max(40) }).parse(req.params);
    const handle = normalizeHandle(params.handle);
    const user = await findUserByHandle(handle, true);
    if (!user) {
      reply.status(404).send({ error: 'identity_not_found' });
      return;
    }
    reply.send({
      handle: user.handle,
      walletAddress: user.wallet_address,
      basename: user.basename ?? null,
    });
  });

  app.put('/v1/profile', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z
      .object({
        userId: z.string().min(1),
        handle: z.string().min(3).optional(),
        basename: z.string().min(3).max(80).optional(),
        discoverableByHandle: z.number().int().min(0).max(1).optional(),
        discoverableByPhone: z.number().int().min(0).max(1).optional(),
      })
      .parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const user = await getUserById(authedUserId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }

    let nextHandle: string | undefined = undefined;
    let handleUpdatedAt: number | undefined = undefined;
    if (typeof body.handle !== 'undefined') {
      nextHandle = normalizeHandle(body.handle);
      if (!isValidHandle(nextHandle)) {
        reply.status(400).send({ error: 'invalid_handle' });
        return;
      }

      const byHandle = await findUserByHandle(nextHandle);
      if (byHandle && byHandle.id !== user.id) {
        reply.status(409).send({ error: 'handle_conflict' });
        return;
      }

      const currentHandle = user.handle ? String(user.handle).toLowerCase() : null;
      if (currentHandle !== nextHandle) {
        handleUpdatedAt = Date.now();
      }
      if (currentHandle && currentHandle !== nextHandle) {
        const last = Number(user.handle_updated_at ?? user.updated_at ?? user.created_at ?? 0);
        const cooldown = env.HANDLE_ROTATION_COOLDOWN_MS;
        const elapsed = last ? Date.now() - last : cooldown + 1;
        if (elapsed >= 0 && elapsed < cooldown) {
          reply.status(409).send({
            error: 'handle_rotation_cooldown',
            retryAfterMs: cooldown - elapsed,
          });
          return;
        }
      }
    }

    const updated = await updateUser({
      id: body.userId,
      handle: nextHandle,
      handleUpdatedAt,
      basename: body.basename,
      discoverableByHandle: body.discoverableByHandle,
      discoverableByPhone: body.discoverableByPhone,
    });
    await auditLog(body.userId, 'profile_updated', { handle: nextHandle, basename: body.basename ?? null });
    reply.send({ user: updated });
  });

  app.put('/v1/pricing', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z
      .object({
        userId: z.string().min(1),
        defaultPrice: z.number().int().min(0),
        firstContactPrice: z.number().int().min(0),
        returnDiscountBps: z.number().int().min(0).max(10_000),
        acceptsAll: z.boolean(),
      })
      .parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const user = await getUserById(body.userId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }

    const profile = await setPricing(body.userId, {
      defaultPrice: body.defaultPrice,
      firstContactPrice: body.firstContactPrice,
      returnDiscountBps: body.returnDiscountBps,
      acceptsAll: body.acceptsAll,
    });
    await auditLog(body.userId, 'pricing_updated', {
      defaultPrice: body.defaultPrice,
      firstContactPrice: body.firstContactPrice,
      returnDiscountBps: body.returnDiscountBps,
      acceptsAll: body.acceptsAll,
    });
    reply.send({ pricing: profile });
  });

  app.get('/v1/recipient/:selector', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const params = z.object({ selector: z.string().min(3) }).parse(req.params);
    const selector = params.selector.trim();
    const handleGuess = selector.startsWith('@') ? selector.slice(1) : selector;
    const user = (await findUserByHandle(handleGuess, true)) || (await findUserByPhone(selector, true));

    if (!user) {
      reply.status(404).send({ error: 'recipient_not_found' });
      return;
    }

    const profile = await getPricing(user.id);
    reply.send({
      id: user.id,
      walletAddress: user.wallet_address,
      handle: user.handle,
      discoverableByPhone: user.discoverable_by_phone,
      discoverableByHandle: user.discoverable_by_handle,
      pricing: {
        defaultPrice: Number(profile?.default_price ?? 200),
        firstContactPrice: Number(profile?.first_contact_price ?? 500),
        returnDiscountBps: Number(profile?.return_discount_bps ?? 500),
      },
    });
  });
}
