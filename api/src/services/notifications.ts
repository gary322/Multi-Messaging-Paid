import { env } from '../config/env';
import { incrementCounter } from '../lib/metrics';

type Logger = (entry: Record<string, any>) => void;

export type NotificationProviderReadiness = {
  provider: string;
  configured: boolean;
  endpoint?: string;
  hasAuthToken?: boolean;
};

export type NotificationResult = {
  ok: boolean;
  status?: number;
  reason?: string;
  requestId?: string;
  provider?: string;
};

export type NotificationReadinessIssue = {
  provider: string;
  channel: string;
  ready: boolean;
  reason: string;
};

type ChannelPayload = {
  subject: string;
  messageId?: string;
  amount?: number;
  txHash?: string | null;
};

const channelNames = ['in_app', 'telegram', 'whatsapp', 'x'] as const;
type NotificationChannel = (typeof channelNames)[number];

function telegramReadiness(): NotificationProviderReadiness {
  return {
    provider: 'telegram',
    configured: Boolean(env.TELEGRAM_BOT_TOKEN),
    endpoint: `${env.TELEGRAM_API_BASE}/bot/sendMessage`,
    hasAuthToken: Boolean(env.TELEGRAM_BOT_TOKEN),
  };
}

function whatsappReadiness(): NotificationProviderReadiness {
  const cloudReady = Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCOUNT_TOKEN);
  return {
    provider: 'whatsapp',
    configured: cloudReady || Boolean(env.WHATSAPP_WEBHOOK_URL),
    endpoint: cloudReady
      ? `${env.WHATSAPP_API_BASE}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
      : env.WHATSAPP_WEBHOOK_URL,
    hasAuthToken: cloudReady || Boolean(env.WHATSAPP_WEBHOOK_TOKEN),
  };
}

function xReadiness(): NotificationProviderReadiness {
  const xCloudReady = Boolean(env.X_BEARER_TOKEN);
  return {
    provider: 'x',
    configured: xCloudReady || Boolean(env.X_WEBHOOK_URL),
    endpoint: xCloudReady ? `${env.X_API_BASE}/messages/create` : env.X_WEBHOOK_URL,
    hasAuthToken: xCloudReady || Boolean(env.X_WEBHOOK_TOKEN),
  };
}

export function getNotificationProviderReadiness() {
  return [telegramReadiness(), whatsappReadiness(), xReadiness()];
}

function getNotificationProviderReadinessFor(channel: string): NotificationProviderReadiness | undefined {
  return getNotificationProviderReadiness().find((item) => item.provider === channel);
}

export function isNotificationChannelReady(channel: string) {
  const readiness = getNotificationProviderReadinessFor(channel);
  if (!readiness?.configured) {
    return false;
  }
  if (env.NOTIFICATION_PROVIDERS_STRICT && !readiness.hasAuthToken) {
    return false;
  }
  return true;
}

export function getNotificationProviderIssue(channel: string): NotificationReadinessIssue | null {
  if (!env.NOTIFICATION_PROVIDERS_STRICT) {
    return null;
  }

  if (env.NOTIFICATION_PROVIDERS_STRICT) {
    const readiness = getNotificationProviderReadinessFor(channel);
    if (!readiness?.configured) {
      return {
        provider: channel,
        channel,
        ready: false,
        reason: 'provider_not_configured',
      };
    }
    if (!readiness.hasAuthToken) {
      return {
        provider: channel,
        channel,
        ready: false,
        reason: 'provider_auth_missing',
      };
    }
  }
  return null;
}

function isSupportedChannel(channel: string): channel is NotificationChannel {
  return (channelNames as readonly string[]).includes(channel);
}

function formatMessage(payload: ChannelPayload) {
  return `${payload.subject}\nMessage ID: ${payload.messageId || 'n/a'}\nAmount: ${payload.amount ?? 'n/a'}\nTx: ${payload.txHash ?? 'n/a'}`;
}

async function postJson(url: string, token: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string; requestId?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      requestId: response.headers.get('x-request-id') || undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegram(destination: string, payload: ChannelPayload, log: Logger): Promise<NotificationResult> {
  if (env.NOTIFICATION_PROVIDERS_STRICT) {
    const issue = getNotificationProviderIssue('telegram');
    if (issue) {
      incrementCounter('mmp_notifications_send_blocked_total', { provider: 'telegram', reason: issue.reason });
      return { ok: false, reason: issue.reason, provider: 'telegram' };
    }
  }
  incrementCounter('mmp_notifications_send_attempts_total', { provider: 'telegram', channel: 'telegram' });
  if (!env.TELEGRAM_BOT_TOKEN) {
    incrementCounter('mmp_notifications_send_blocked_total', {
      provider: 'telegram',
      reason: 'not_configured',
    });
    return { ok: false, reason: 'telegram_not_configured', provider: 'telegram' };
  }
  if (!destination) {
    return { ok: false, reason: 'telegram_destination_missing', provider: 'telegram' };
  }
  const text = formatMessage(payload);
  const url = `${env.TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const result = await postJson(
    url,
    '',
    {
      chat_id: destination,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
    env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
  );
  if (!result.ok) {
    incrementCounter('mmp_notifications_send_failures_total', { provider: 'telegram', reason: String(result.status) });
    log({
      provider: 'telegram',
      destination,
      status: result.status,
      reason: result.text.slice(0, 220),
    });
    return {
      ok: false,
      status: result.status,
      reason: `telegram_request_failed:${result.status}`,
      provider: 'telegram',
      requestId: result.requestId,
    };
  }
  incrementCounter('mmp_notifications_send_success_total', { provider: 'telegram' });
  log({ provider: 'telegram', destination, status: result.status });
  return { ok: true, status: result.status, provider: 'telegram', requestId: result.requestId };
}

async function sendWhatsApp(destination: string, payload: ChannelPayload, log: Logger): Promise<NotificationResult> {
  if (env.NOTIFICATION_PROVIDERS_STRICT) {
    const issue = getNotificationProviderIssue('whatsapp');
    if (issue) {
      incrementCounter('mmp_notifications_send_blocked_total', { provider: 'whatsapp', reason: issue.reason });
      return { ok: false, reason: issue.reason, provider: 'whatsapp' };
    }
  }
  incrementCounter('mmp_notifications_send_attempts_total', { provider: 'whatsapp', channel: 'whatsapp' });
  if (!env.WHATSAPP_PHONE_NUMBER_ID && !env.WHATSAPP_WEBHOOK_URL) {
    incrementCounter('mmp_notifications_send_blocked_total', {
      provider: 'whatsapp',
      reason: 'not_configured',
    });
    return { ok: false, reason: 'whatsapp_not_configured', provider: 'whatsapp' };
  }
  if (!destination) {
    return { ok: false, reason: 'whatsapp_destination_missing', provider: 'whatsapp' };
  }
  const useCloudApi = Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCOUNT_TOKEN);
  const endpoint = useCloudApi
    ? `${env.WHATSAPP_API_BASE}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
    : env.WHATSAPP_WEBHOOK_URL;
  const result = await postJson(
    endpoint,
    useCloudApi ? env.WHATSAPP_ACCOUNT_TOKEN : env.WHATSAPP_WEBHOOK_TOKEN,
    useCloudApi
      ? {
          messaging_product: 'whatsapp',
          to: destination,
          type: 'text',
          text: {
            preview_url: false,
            body: formatMessage(payload),
          },
        }
      : {
          to: destination,
          channel: 'notifications',
          type: 'paid_message',
          subject: payload.subject,
          messageId: payload.messageId,
          amount: payload.amount,
          txHash: payload.txHash,
        },
    env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
  );
  if (!result.ok) {
    incrementCounter('mmp_notifications_send_failures_total', { provider: 'whatsapp', reason: String(result.status) });
    log({
      provider: 'whatsapp',
      destination,
      status: result.status,
      reason: result.text.slice(0, 220),
    });
    return {
      ok: false,
      status: result.status,
      reason: `whatsapp_request_failed:${result.status}`,
      provider: 'whatsapp',
      requestId: result.requestId,
    };
  }
  incrementCounter('mmp_notifications_send_success_total', { provider: 'whatsapp' });
  log({ provider: 'whatsapp', destination, status: result.status });
  return { ok: true, status: result.status, provider: 'whatsapp', requestId: result.requestId };
}

async function sendX(destination: string, payload: ChannelPayload, log: Logger): Promise<NotificationResult> {
  if (env.NOTIFICATION_PROVIDERS_STRICT) {
    const issue = getNotificationProviderIssue('x');
    if (issue) {
      incrementCounter('mmp_notifications_send_blocked_total', { provider: 'x', reason: issue.reason });
      return { ok: false, reason: issue.reason, provider: 'x' };
    }
  }
  incrementCounter('mmp_notifications_send_attempts_total', { provider: 'x', channel: 'x' });
  if (!env.X_WEBHOOK_URL && !env.X_BEARER_TOKEN) {
    incrementCounter('mmp_notifications_send_blocked_total', {
      provider: 'x',
      reason: 'not_configured',
    });
    return { ok: false, reason: 'x_not_configured', provider: 'x' };
  }
  if (!destination) {
    return { ok: false, reason: 'x_destination_missing', provider: 'x' };
  }
  const useCloudApi = Boolean(env.X_BEARER_TOKEN);
  const endpoint = useCloudApi ? `${env.X_API_BASE}/direct_messages` : env.X_WEBHOOK_URL;
  const result = await postJson(
    endpoint,
    useCloudApi ? env.X_BEARER_TOKEN : env.X_WEBHOOK_TOKEN,
    {
      recipient: destination,
      event: useCloudApi ? undefined : 'paid_message',
      text: useCloudApi ? formatMessage(payload) : formatMessage(payload),
      message: useCloudApi
        ? {
            text: formatMessage(payload),
          }
        : undefined,
    },
    env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
  );
  if (!result.ok) {
    incrementCounter('mmp_notifications_send_failures_total', { provider: 'x', reason: String(result.status) });
    log({
      provider: 'x',
      destination,
      status: result.status,
      reason: result.text.slice(0, 220),
    });
    return {
      ok: false,
      status: result.status,
      reason: `x_request_failed:${result.status}`,
      provider: 'x',
      requestId: result.requestId,
    };
  }
  incrementCounter('mmp_notifications_send_success_total', { provider: 'x' });
  log({ provider: 'x', destination, status: result.status });
  return { ok: true, status: result.status, provider: 'x', requestId: result.requestId };
}

async function sendInApp(payload: ChannelPayload, log: Logger): Promise<NotificationResult> {
  log({ provider: 'in_app', messageId: payload.messageId ?? 'n/a' });
  return { ok: true, provider: 'in_app' };
}

export async function sendNotification(
  channel: string,
  destination: string,
  payload: ChannelPayload,
  log: Logger,
): Promise<NotificationResult> {
  if (!isSupportedChannel(channel)) {
    incrementCounter('mmp_notifications_dispatch_total', { channel, status: 'unsupported' });
    return { ok: false, reason: `unsupported_channel:${channel}` };
  }
  incrementCounter('mmp_notifications_dispatch_total', { channel, status: 'requested' });

  if (channel === 'telegram') return sendTelegram(destination, payload, log);
  if (channel === 'whatsapp') return sendWhatsApp(destination, payload, log);
  if (channel === 'x') return sendX(destination, payload, log);
  return sendInApp(payload, log);
}

export const supportedNotificationChannels = channelNames.filter((name) => name !== 'in_app');
