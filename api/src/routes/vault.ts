import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditLog, deleteVaultBlob, getUserById, getVaultBlob, upsertVaultBlob } from '../lib/db';
import { requireAuthUser } from '../lib/auth';
import { requireLaunchReady } from '../lib/complianceGuard';

const MAX_VAULT_BLOB_BYTES = 256 * 1024;

export default async function (app: FastifyInstance) {
  app.get('/v1/vault/blob', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const query = z.object({ userId: z.string().min(1) }).parse(req.query);
    const authedUserId = requireAuthUser(req, reply, query.userId);
    if (!authedUserId) return;

    const blob = await getVaultBlob(query.userId);
    if (!blob) {
      reply.status(404).send({ error: 'vault_blob_not_found' });
      return;
    }
    reply.send({
      userId: query.userId,
      blob: blob.blob_json,
      version: blob.version,
      createdAt: blob.created_at,
      updatedAt: blob.updated_at,
    });
  });

  app.put('/v1/vault/blob', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z
      .object({
        userId: z.string().min(1),
        blob: z.string().min(2),
        version: z.number().int().positive().optional(),
      })
      .parse(req.body);

    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const user = await getUserById(authedUserId);
    if (!user) {
      reply.status(404).send({ error: 'user_not_found' });
      return;
    }

    if (Buffer.byteLength(body.blob, 'utf8') > MAX_VAULT_BLOB_BYTES) {
      reply.status(413).send({ error: 'vault_blob_too_large', maxBytes: MAX_VAULT_BLOB_BYTES });
      return;
    }

    const record = await upsertVaultBlob(body.userId, body.blob, body.version ?? 1);
    await auditLog(body.userId, 'vault_blob_upserted', {
      version: record.version,
      bytes: Buffer.byteLength(record.blob_json, 'utf8'),
    });

    reply.send({
      ok: true,
      userId: body.userId,
      version: record.version,
      updatedAt: record.updated_at,
    });
  });

  app.delete('/v1/vault/blob', async (req, reply) => {
    if (!requireLaunchReady(req, reply)) {
      return;
    }

    const body = z.object({ userId: z.string().min(1) }).parse(req.body);
    const authedUserId = requireAuthUser(req, reply, body.userId);
    if (!authedUserId) return;

    const deleted = await deleteVaultBlob(body.userId);
    await auditLog(body.userId, 'vault_blob_deleted', { deleted });
    reply.send({ ok: true, deleted });
  });
}

