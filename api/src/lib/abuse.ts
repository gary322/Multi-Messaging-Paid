import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { env } from '../config/env';
import { incrementCounter } from './metrics';
import {
  type AbuseKeyType,
  auditLog,
  getActiveAbuseBlock,
  incrementAbuseCounter,
  recordAbuseEvent,
  upsertAbuseBlock,
} from './db';

type AbuseCheckInput = {
  senderId: string;
  recipientId: string;
};

type AbuseCheckOk = { ok: true };
type AbuseCheckBlocked = {
  ok: false;
  blockedUntil: number;
  retryAfterMs: number;
  reason: string;
};

type AbuseCheckResult = AbuseCheckOk | AbuseCheckBlocked;

function safeNumber(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clampAtLeast(value: number, min: number) {
  return Math.max(min, Number.isFinite(value) ? value : min);
}

function stableKeyHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function windowStartFor(nowMs: number, windowMs: number) {
  const size = clampAtLeast(windowMs, 1);
  return Math.floor(nowMs / size) * size;
}

function deriveIpKey(req: FastifyRequest) {
  const ip = String(req.ip || '').trim() || 'unknown';
  return stableKeyHash(`ip:${ip}`);
}

function deriveDeviceKey(req: FastifyRequest): { deviceKey: string | null; hasUserAgent: boolean } {
  const explicit = String(req.headers['x-mmp-device-id'] || req.headers['x-device-id'] || '').trim();
  const userAgent = String(req.headers['user-agent'] || '').trim();
  const hasUserAgent = userAgent.length > 0;

  if (explicit) {
    return { deviceKey: stableKeyHash(`device:${explicit}`), hasUserAgent };
  }

  const hints = [
    userAgent,
    String(req.headers['sec-ch-ua'] || '').trim(),
    String(req.headers['sec-ch-ua-platform'] || '').trim(),
    String(req.headers['sec-ch-ua-mobile'] || '').trim(),
    String(req.headers['accept-language'] || '').trim(),
  ].filter(Boolean);

  if (hints.length === 0) {
    return { deviceKey: null, hasUserAgent: false };
  }

  return { deviceKey: stableKeyHash(`ua:${hints.join('|')}`), hasUserAgent };
}

function scoreExcess(count: number, maxPerWindow: number, weight: number) {
  const max = clampAtLeast(maxPerWindow, 0);
  const w = clampAtLeast(weight, 0);
  const excess = Math.max(0, Math.floor(count) - Math.floor(max));
  return { excess, score: excess * w };
}

function collectBlockKeys(params: {
  senderExcess: number;
  recipientExcess: number;
  ipExcess: number;
  deviceExcess: number;
  senderId: string;
  recipientId: string;
  ipKey: string;
  deviceKey: string | null;
}) {
  const keys: Array<{ keyType: AbuseKeyType; keyValue: string }> = [];
  if (params.senderExcess > 0 && params.senderId) keys.push({ keyType: 'sender', keyValue: params.senderId });
  if (params.recipientExcess > 0 && params.recipientId)
    keys.push({ keyType: 'recipient', keyValue: params.recipientId });
  if (params.ipExcess > 0 && params.ipKey) keys.push({ keyType: 'ip', keyValue: params.ipKey });
  if (params.deviceExcess > 0 && params.deviceKey) keys.push({ keyType: 'device', keyValue: params.deviceKey });

  // If scoring tripped due to a configuration edge (eg: UA penalty with a low limit),
  // always block at least the sender + ip.
  if (keys.length === 0) {
    if (params.senderId) keys.push({ keyType: 'sender', keyValue: params.senderId });
    if (params.ipKey) keys.push({ keyType: 'ip', keyValue: params.ipKey });
  }

  return keys;
}

export async function checkMessageSendAbuse(req: FastifyRequest, input: AbuseCheckInput): Promise<AbuseCheckResult> {
  if (!env.ABUSE_CONTROL_ENABLED) {
    return { ok: true };
  }

  const nowMs = Date.now();
  const windowMs = safeNumber(env.ABUSE_WINDOW_MS, 300_000);
  const windowStart = windowStartFor(nowMs, windowMs);

  const ipKey = deriveIpKey(req);
  const { deviceKey, hasUserAgent } = deriveDeviceKey(req);

  // Hard block gate: if any identifier is currently blocked, deny without incrementing counters.
  const blockChecks: Array<[AbuseKeyType, string]> = [
    ['sender', input.senderId],
    ['recipient', input.recipientId],
    ['ip', ipKey],
  ];
  if (deviceKey) {
    blockChecks.push(['device', deviceKey]);
  }

  for (const [keyType, keyValue] of blockChecks) {
    const active = await getActiveAbuseBlock(keyType, keyValue);
    if (!active) continue;
    const retryAfterMs = Math.max(0, active.blockedUntil - nowMs);
    incrementCounter('mmp_abuse_checks_total', {
      action: 'message_send',
      decision: 'block',
      reason: `active_block:${active.keyType}`,
    });
    return { ok: false, blockedUntil: active.blockedUntil, retryAfterMs, reason: 'abuse_blocked' };
  }

  const senderCount = await incrementAbuseCounter({
    keyType: 'sender',
    keyValue: input.senderId,
    windowStart,
  });
  const recipientCount = await incrementAbuseCounter({
    keyType: 'recipient',
    keyValue: input.recipientId,
    windowStart,
  });
  const ipCount = await incrementAbuseCounter({
    keyType: 'ip',
    keyValue: ipKey,
    windowStart,
  });
  const deviceCount = deviceKey
    ? await incrementAbuseCounter({
        keyType: 'device',
        keyValue: deviceKey,
        windowStart,
      })
    : 0;

  const sender = scoreExcess(senderCount, safeNumber(env.ABUSE_SENDER_MAX_PER_WINDOW, 12), safeNumber(env.ABUSE_SENDER_SCORE_WEIGHT, 6));
  const recipient = scoreExcess(recipientCount, safeNumber(env.ABUSE_RECIPIENT_MAX_PER_WINDOW, 80), safeNumber(env.ABUSE_RECIPIENT_SCORE_WEIGHT, 2));
  const ip = scoreExcess(ipCount, safeNumber(env.ABUSE_IP_MAX_PER_WINDOW, 40), safeNumber(env.ABUSE_IP_SCORE_WEIGHT, 4));
  const device = scoreExcess(deviceCount, safeNumber(env.ABUSE_DEVICE_MAX_PER_WINDOW, 30), safeNumber(env.ABUSE_DEVICE_SCORE_WEIGHT, 2));

  const uaPenalty = !hasUserAgent ? safeNumber(env.ABUSE_DEVICE_MISSING_UA_PENALTY, 2) : 0;
  const score = sender.score + recipient.score + ip.score + device.score + uaPenalty;
  const limit = safeNumber(env.ABUSE_SCORE_LIMIT, 24);

  if (score < limit) {
    incrementCounter('mmp_abuse_checks_total', { action: 'message_send', decision: 'allow', reason: 'ok' });
    return { ok: true };
  }

  const blockedUntil = nowMs + safeNumber(env.ABUSE_BLOCK_DURATION_MS, 180_000);
  const keysToBlock = collectBlockKeys({
    senderExcess: sender.excess,
    recipientExcess: recipient.excess,
    ipExcess: ip.excess,
    deviceExcess: device.excess,
    senderId: input.senderId,
    recipientId: input.recipientId,
    ipKey,
    deviceKey,
  });

  const reasons: string[] = [];
  if (sender.excess > 0) reasons.push('sender_velocity');
  if (recipient.excess > 0) reasons.push('recipient_velocity');
  if (ip.excess > 0) reasons.push('ip_velocity');
  if (device.excess > 0) reasons.push('device_velocity');
  if (!hasUserAgent && uaPenalty > 0) reasons.push('missing_user_agent');

  const primaryReason = reasons[0] || 'abuse_score_limit';

  await Promise.all(
    keysToBlock.map((key) =>
      upsertAbuseBlock({
        keyType: key.keyType,
        keyValue: key.keyValue,
        blockedUntil,
        reason: primaryReason,
        metadata: {
          action: 'message_send',
          score,
          scoreLimit: limit,
          windowStart,
        },
      }),
    ),
  );

  // Best-effort reporting hooks: DB abuse event + per-user audit log (hashed identifiers only).
  await recordAbuseEvent({
    action: 'message_send',
    decision: 'block',
    score,
    senderId: input.senderId,
    recipientId: input.recipientId,
    ipKey,
    deviceKey,
    windowStart,
    reason: primaryReason,
    details: {
      counts: {
        sender: senderCount,
        recipient: recipientCount,
        ip: ipCount,
        device: deviceCount,
      },
      excess: {
        sender: sender.excess,
        recipient: recipient.excess,
        ip: ip.excess,
        device: device.excess,
      },
      penalties: {
        missingUserAgent: uaPenalty,
      },
      keysBlocked: keysToBlock.map((k) => k.keyType),
    },
  }).catch(() => {});

  await auditLog(input.senderId, 'abuse_blocked', {
    action: 'message_send',
    recipientId: input.recipientId,
    score,
    scoreLimit: limit,
    reason: primaryReason,
    blockedUntil,
    retryAfterMs: Math.max(0, blockedUntil - nowMs),
    ipKey,
    deviceKey,
    windowStart,
    counts: {
      sender: senderCount,
      recipient: recipientCount,
      ip: ipCount,
      device: deviceCount,
    },
  }).catch(() => {});

  incrementCounter('mmp_abuse_checks_total', { action: 'message_send', decision: 'block', reason: primaryReason });
  return {
    ok: false,
    blockedUntil,
    retryAfterMs: Math.max(0, blockedUntil - nowMs),
    reason: 'abuse_blocked',
  };
}

