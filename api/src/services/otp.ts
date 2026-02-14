import { env } from '../config/env';
import { incrementCounter, observeDuration } from '../lib/metrics';

type Logger = (entry: Record<string, any>) => void;

export type OtpChannel = 'phone' | 'email';

export type OtpProviderReadiness = {
  channel: OtpChannel;
  provider: string;
  configured: boolean;
  hasAuthToken: boolean;
};

export type OtpSendResult = {
  ok: boolean;
  provider: string;
  status?: number;
  reason?: string;
  requestId?: string;
};

function normalizeProvider(value: string) {
  return (value || '').trim().toLowerCase();
}

function smsProvider() {
  return normalizeProvider(env.OTP_SMS_PROVIDER);
}

function emailProvider() {
  return normalizeProvider(env.OTP_EMAIL_PROVIDER);
}

export function getOtpProviderReadiness(): OtpProviderReadiness[] {
  const sms = smsProvider();
  const email = emailProvider();
  const smsConfigured = sms !== 'disabled';
  const emailConfigured = email !== 'disabled';
  const smsHasAuth =
    sms === 'twilio'
      ? Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER)
      : sms === 'console'
        ? true
        : false;
  const emailHasAuth =
    email === 'sendgrid'
      ? Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL)
      : email === 'console'
        ? true
        : false;

  return [
    { channel: 'phone', provider: sms || 'disabled', configured: smsConfigured, hasAuthToken: smsHasAuth },
    { channel: 'email', provider: email || 'disabled', configured: emailConfigured, hasAuthToken: emailHasAuth },
  ];
}

function twilioEndpoint() {
  return `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
}

function twilioAuthHeader() {
  const raw = `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

async function postForm(
  url: string,
  headers: Record<string, string>,
  form: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string; requestId?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams(form).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body,
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

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string; requestId?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
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

function otpMessage(code: string) {
  return `Your MMP verification code is ${code}.`;
}

async function sendSmsViaTwilio(to: string, code: string, log: Logger): Promise<OtpSendResult> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    return { ok: false, provider: 'twilio', reason: 'twilio_not_configured' };
  }

  const start = Date.now();
  const result = await postForm(
    twilioEndpoint(),
    { authorization: twilioAuthHeader() },
    {
      To: to,
      From: env.TWILIO_FROM_NUMBER,
      Body: otpMessage(code),
    },
    env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
  );
  observeDuration('mmp_otp_provider_request_ms', { provider: 'twilio', channel: 'phone' }, Date.now() - start);

  if (!result.ok) {
    log({
      provider: 'twilio',
      channel: 'phone',
      destination: to,
      status: result.status,
      reason: result.text.slice(0, 220),
    });
    return { ok: false, provider: 'twilio', status: result.status, reason: `twilio_request_failed:${result.status}` };
  }
  return { ok: true, provider: 'twilio', status: result.status };
}

async function sendEmailViaSendGrid(to: string, code: string, log: Logger): Promise<OtpSendResult> {
  if (!env.SENDGRID_API_KEY || !env.SENDGRID_FROM_EMAIL) {
    return { ok: false, provider: 'sendgrid', reason: 'sendgrid_not_configured' };
  }

  const start = Date.now();
  const result = await postJson(
    'https://api.sendgrid.com/v3/mail/send',
    { authorization: `Bearer ${env.SENDGRID_API_KEY}` },
    {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.SENDGRID_FROM_EMAIL },
      subject: 'Your MMP verification code',
      content: [{ type: 'text/plain', value: otpMessage(code) }],
    },
    env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
  );
  observeDuration('mmp_otp_provider_request_ms', { provider: 'sendgrid', channel: 'email' }, Date.now() - start);

  if (!result.ok) {
    log({
      provider: 'sendgrid',
      channel: 'email',
      destination: to,
      status: result.status,
      reason: result.text.slice(0, 220),
    });
    return {
      ok: false,
      provider: 'sendgrid',
      status: result.status,
      reason: `sendgrid_request_failed:${result.status}`,
      requestId: result.requestId,
    };
  }
  return { ok: true, provider: 'sendgrid', status: result.status, requestId: result.requestId };
}

async function sendViaConsole(channel: OtpChannel, destination: string, code: string, log: Logger): Promise<OtpSendResult> {
  log({ provider: 'console', channel, destination, message: otpMessage(code) });
  return { ok: true, provider: 'console' };
}

export async function sendOtp(channel: OtpChannel, destination: string, code: string, log: Logger): Promise<OtpSendResult> {
  const provider = channel === 'phone' ? smsProvider() : emailProvider();
  const safeLog = log || (() => {});

  incrementCounter('mmp_otp_send_attempts_total', { channel, provider: provider || 'unknown' });
  try {
    if (!provider || provider === 'disabled') {
      incrementCounter('mmp_otp_send_blocked_total', { channel, provider: provider || 'disabled' });
      return { ok: false, provider: provider || 'disabled', reason: 'otp_provider_disabled' };
    }

    if (provider === 'console') {
      const result = await sendViaConsole(channel, destination, code, safeLog);
      incrementCounter('mmp_otp_send_success_total', { channel, provider: result.provider });
      return result;
    }

    if (channel === 'phone' && provider === 'twilio') {
      const result = await sendSmsViaTwilio(destination, code, safeLog);
      incrementCounter(result.ok ? 'mmp_otp_send_success_total' : 'mmp_otp_send_failures_total', {
        channel,
        provider: result.provider,
      });
      return result;
    }

    if (channel === 'email' && provider === 'sendgrid') {
      const result = await sendEmailViaSendGrid(destination, code, safeLog);
      incrementCounter(result.ok ? 'mmp_otp_send_success_total' : 'mmp_otp_send_failures_total', {
        channel,
        provider: result.provider,
      });
      return result;
    }

    incrementCounter('mmp_otp_send_failures_total', { channel, provider: provider || 'unknown' });
    return { ok: false, provider: provider || 'unknown', reason: `unsupported_otp_provider:${provider}` };
  } catch (error) {
    safeLog({
      provider: provider || 'unknown',
      channel,
      destination,
      error: error instanceof Error ? error.message : String(error),
    });
    incrementCounter('mmp_otp_send_failures_total', { channel, provider: provider || 'unknown' });
    return { ok: false, provider: provider || 'unknown', reason: 'otp_send_exception' };
  }
}

