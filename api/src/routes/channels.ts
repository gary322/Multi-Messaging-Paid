import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditLog, getChannelConnection, getUserById, saveChannelConnection } from '../lib/db';
import { requireAuthUser } from '../lib/auth';
import { requireLaunchReady } from '../lib/complianceGuard';
import { env } from '../config/env';
import { getNotificationProviderIssue } from '../services/notifications';

function looksLikeEncryptedEnvelope(value: string) {
  if (value.startsWith('vault:') || value.startsWith('vault://')) {
    return true;
  }
  try {
    const parsed = JSON.parse(value) as { ciphertext?: string; iv?: string; tag?: string };
    return Boolean(parsed && parsed.ciphertext && parsed.iv && parsed.tag);
  } catch {
    return false;
  }
}

export default async function (app: FastifyInstance) {
  app.post('/v1/channels/:channel/connect', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const params = z.object({ channel: z.enum(['telegram', 'whatsapp', 'x']) }).parse(req.params);
    const body = z.object({
      userId: z.string().min(1),
      externalHandle: z.string().min(1),
      secret: z.string().optional(),
      consentVersion: z.string().default('v1'),
      termsAccepted: z.boolean().optional(),
      termsVersion: z.string().optional(),
      termsAcceptedAt: z.number().optional(),
    }).parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const user = await getUserById(authedUserId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }

    if (env.REQUIRE_SOCIAL_TOS_ACCEPTED && ['whatsapp', 'x'].includes(params.channel)) {
      if (body.termsAccepted !== true) {
        reply.status(403).send({
          error: 'compliance_required',
          message: 'Explicit terms acceptance required for WhatsApp/X connectors.',
        });
        return;
      }

      if (!body.termsAcceptedAt || body.termsAcceptedAt <= 0) {
        reply.status(403).send({
          error: 'compliance_required',
          message: 'termsAcceptedAt is required for WhatsApp/X connectors.',
        });
        return;
      }
    }

    const issue = getNotificationProviderIssue(params.channel);
    if (issue) {
      reply.status(503).send({
        error: 'notification_provider_unavailable',
        message: `Notification provider for ${params.channel} is not available: ${issue.reason}`,
        provider: params.channel,
        reason: issue.reason,
      });
      return;
    }

    const expectedTermsVersion = body.termsVersion || body.consentVersion;
    if (env.REQUIRE_SOCIAL_TOS_ACCEPTED && ['whatsapp', 'x'].includes(params.channel) && expectedTermsVersion !== env.LEGAL_TOS_VERSION) {
      reply.status(403).send({
        error: 'compliance_required',
        message: 'Terms version accepted via termsVersion does not match legal terms version.',
      });
      return;
    }

    const consentAcceptedAt =
      body.termsAccepted && env.REQUIRE_SOCIAL_TOS_ACCEPTED ? body.termsAcceptedAt ?? Date.now() : null;

    if (body.secret && !looksLikeEncryptedEnvelope(body.secret)) {
      reply.status(400).send({
        error: 'invalid_secret_format',
        message: 'Channel secret must be an encrypted envelope or vault reference; plaintext secrets are not accepted.',
      });
      return;
    }

    await saveChannelConnection(user.id, params.channel, {
      externalHandle: body.externalHandle,
      secretRef: body.secret ?? null,
      consentVersion: expectedTermsVersion,
      consentAcceptedAt,
      status: 'connected',
    });
    await auditLog(user.id, 'channel_connected', {
      channel: params.channel,
      externalHandle: body.externalHandle,
      consentVersion: expectedTermsVersion,
      termsAccepted: body.termsAccepted ?? false,
      termsAcceptedAt: consentAcceptedAt,
      auditContext: 'connect',
    });

    app.log.info({ channel: params.channel, userId: user.id, connected: true }, 'channel connect');
    reply.send({
      channel: params.channel,
      connected: true,
      consentVersion: expectedTermsVersion,
      consentAcceptedAt,
    });
  });

  app.get('/v1/channels/:channel/status', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const params = z.object({ channel: z.enum(['telegram', 'whatsapp', 'x']) }).parse(req.params);
    const query = z.object({ userId: z.string().min(1) }).parse(req.query);
    const authedUserId = requireAuthUser(req, reply, query.userId);
    if (!authedUserId) return;

    const conn = await getChannelConnection(query.userId, params.channel);
    if (!conn) {
      reply.status(404).send({ connected: false });
      return;
    }
    return reply.send({
      channel: params.channel,
      connected: conn.status === 'connected',
      status: conn.status,
      externalHandle: conn.external_handle,
      consentVersion: conn.consent_version,
      consentAcceptedAt: conn.consent_accepted_at ?? null,
    });
  });

  app.post('/v1/channels/:channel/disconnect', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const params = z.object({ channel: z.enum(['telegram', 'whatsapp', 'x']) }).parse(req.params);
    const body = z.object({ userId: z.string().min(1) }).parse(req.body);
    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const user = await getUserById(authedUserId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }
    await saveChannelConnection(user.id, params.channel, {
      externalHandle: null,
      secretRef: null,
      consentVersion: null,
      consentAcceptedAt: null,
      status: 'disconnected',
    });
    await auditLog(user.id, 'channel_disconnected', {
      channel: params.channel,
    });
    reply.send({ channel: params.channel, connected: false });
  });
}
