import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditLog, createVerificationCode, verifyCode, getUserById, updateUser } from '../lib/db';
import { requireAuthUser } from '../lib/auth';
import { requireLaunchReady } from '../lib/complianceGuard';
import { env } from '../config/env';
import { maskEmail, maskPhone } from '../lib/pii';
import { sendOtp } from '../services/otp';

function randomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export default async function (app: FastifyInstance) {
  app.post('/v1/verify/request', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z
      .object({
        userId: z.string().min(1),
        channel: z.enum(['phone', 'email']),
        target: z.string().min(3),
      })
      .parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const user = await getUserById(authedUserId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }
    const code = randomCode();
    await createVerificationCode(authedUserId, body.channel, body.target, code);
    const maskedTarget = body.channel === 'email' ? maskEmail(body.target) : maskPhone(body.target);
    const delivery = await sendOtp(body.channel, body.target, code, (entry) => app.log.info(entry, 'otp send'));
    if (!delivery.ok) {
      await auditLog(authedUserId, 'verification_delivery_failed', {
        channel: body.channel,
        target: maskedTarget,
        provider: delivery.provider,
        reason: delivery.reason || 'unknown',
      });
      reply.status(503).send({ error: 'otp_delivery_failed', provider: delivery.provider, reason: delivery.reason });
      return;
    }
    await auditLog(authedUserId, 'verification_requested', {
      channel: body.channel,
      target: maskedTarget,
      provider: delivery.provider,
    });
    const response: Record<string, any> = { requested: true, delivered: true, provider: delivery.provider, target: maskedTarget };
    if (env.OTP_DEBUG_RETURN_CODE) {
      response.code = code;
    }
    return reply.send(response);
  });

  app.post('/v1/verify/confirm', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z
      .object({
        userId: z.string().min(1),
        channel: z.enum(['phone', 'email']),
        target: z.string().min(3),
        code: z.string().length(6),
      })
      .parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const ok = await verifyCode(authedUserId, body.channel, body.target, body.code);
    if (!ok) {
      reply.status(400).send({ ok: false });
      return;
    }

    const payload =
      body.channel === 'email'
        ? { emailVerified: 1, email: body.target }
        : { phoneVerified: 1, phone: body.target };

    const user = await getUserById(authedUserId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }
    const updated = await updateUser({ id: user.id, ...payload });
    const maskedTarget = body.channel === 'email' ? maskEmail(body.target) : maskPhone(body.target);
    await auditLog(authedUserId, 'verification_confirmed', { channel: body.channel, target: maskedTarget });
    reply.send({ ok: true, user: updated });
  });
}
