import { getNotificationProviderReadiness, sendNotification } from '../src/services/notifications';
import { env } from '../src/config/env';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

describe('notifications', () => {
  beforeEach(() => {
    delete (global as any).fetch;
  });

  it('sends telegram payload through official bot API endpoint', async () => {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: 'telegram-token',
        NOTIFICATION_PROVIDER_TIMEOUT_MS: 250,
      },
      async () => {
        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => 'ok',
          headers: {
            get: () => 'trace-1',
          },
        } as any);
        (global as any).fetch = fetchMock;

        const result = await sendNotification(
          'telegram',
          '@recipient',
          { subject: 'New paid message', messageId: 'abc', amount: 12, txHash: '0x123' },
          () => undefined,
        );

        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.telegram.org/bottelegram-token/sendMessage');
        expect(options.headers).toMatchObject({ 'content-type': 'application/json' });
        const body = JSON.parse(options.body);
        expect(body.chat_id).toBe('@recipient');
        expect(body.text).toContain('Message ID: abc');
      },
    );
  });

  it('sends x notification through bearer token endpoint', async () => {
    await withEnv(
      {
        X_BEARER_TOKEN: 'x-token',
      },
      async () => {
        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => 'ok',
          headers: { get: () => null },
        } as any);
        (global as any).fetch = fetchMock;

        const result = await sendNotification(
          'x',
          'user',
          { subject: 'New paid message', messageId: 'abc', amount: 12, txHash: '0x123' },
          () => undefined,
        );

        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.x.com/2/direct_messages');
      },
    );
  });

  it('sends whatsapp payload to legacy webhook when cloud credentials are not used', async () => {
    await withEnv(
      {
        NOTIFICATION_PROVIDERS_STRICT: false,
        WHATSAPP_WEBHOOK_URL: 'https://whatsapp.example/legacy',
        WHATSAPP_WEBHOOK_TOKEN: 'legacy-token',
        WHATSAPP_PHONE_NUMBER_ID: '',
      },
      async () => {
        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => 'ok',
          headers: { get: () => 'legacy-id' },
        } as any);
        (global as any).fetch = fetchMock;

        const result = await sendNotification(
          'whatsapp',
          '+15550002222',
          { subject: 'New paid message', messageId: 'abc', amount: 12, txHash: '0x123' },
          () => undefined,
        );

        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://whatsapp.example/legacy');
        expect(options.headers).toMatchObject({ authorization: 'Bearer legacy-token' });
        const body = JSON.parse(options.body);
        expect(body.channel).toBe('notifications');
        expect(body.type).toBe('paid_message');
      },
    );
  });

  it('returns notification provider error when remote channel endpoint fails', async () => {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: 'telegram-token',
      },
      async () => {
        const fetchMock = jest.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => 'down',
          headers: { get: () => 'error-id' },
        } as any);
        (global as any).fetch = fetchMock;

        const result = await sendNotification(
          'telegram',
          '@recipient',
          { subject: 'New paid message', messageId: 'abc', amount: 12, txHash: '0x123' },
          () => undefined,
        );

        expect(result.ok).toBe(false);
        expect(result.status).toBe(500);
        expect(result.reason).toBe('telegram_request_failed:500');
        expect(result.requestId).toBe('error-id');
      },
    );
  });

  it('returns unsupported channel reason for unknown notification channel', async () => {
    const result = await sendNotification(
      'unknown',
      'dest',
      { subject: 'New paid message' },
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_channel:unknown');
  });

  it('blocks notification send in strict mode when provider is not ready', async () => {
    await withEnv(
      {
        NOTIFICATION_PROVIDERS_STRICT: true,
        TELEGRAM_BOT_TOKEN: '',
        WHATSAPP_WEBHOOK_URL: '',
        WHATSAPP_WEBHOOK_TOKEN: '',
        X_WEBHOOK_URL: '',
        X_WEBHOOK_TOKEN: '',
      },
      async () => {
        const result = await sendNotification(
          'telegram',
          '@recipient',
          { subject: 'New paid message', messageId: 'abc', amount: 12 },
          () => undefined,
        );

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('provider_not_configured');
      },
    );
  });

  it('reports provider readiness from env configuration', async () => {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: 'telegram-token',
        WHATSAPP_WEBHOOK_URL: 'https://whatsapp.example/callback',
        WHATSAPP_WEBHOOK_TOKEN: 'whatsapp-token',
        X_WEBHOOK_URL: '',
        X_BEARER_TOKEN: '',
      },
      async () => {
        const providers = getNotificationProviderReadiness();
        const telegram = providers.find((item) => item.provider === 'telegram');
        const whatsapp = providers.find((item) => item.provider === 'whatsapp');
        const x = providers.find((item) => item.provider === 'x');
        expect(telegram?.configured).toBe(true);
        expect(whatsapp?.configured).toBe(true);
        expect(Boolean(x?.configured)).toBe(false);
      },
    );
  });
});

describe('notifications strict provider enforcement', () => {
  beforeEach(() => {
    delete (global as any).fetch;
  });

  it('requires webhook credentials when strict mode is enabled for whatsapp', async () => {
    await withEnv(
      {
        NOTIFICATION_PROVIDERS_STRICT: true,
        WHATSAPP_WEBHOOK_URL: 'https://whatsapp.example/callback',
      },
      async () => {
        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => 'ok',
          headers: { get: () => null },
        } as any);
        (global as any).fetch = fetchMock;

        const result = await sendNotification(
          'whatsapp',
          '+15550001111',
          { subject: 'New paid message' },
          () => undefined,
        );

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('provider_auth_missing');
      },
    );
  });

  it('sends whatsapp payload with cloud credentials', async () => {
    await withEnv(
      {
        NOTIFICATION_PROVIDERS_STRICT: false,
        WHATSAPP_PHONE_NUMBER_ID: 'phone-id-1',
        WHATSAPP_ACCOUNT_TOKEN: 'acct-token',
      },
      async () => {
        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => 'ok',
          headers: { get: () => 'whatsapp-1' },
        } as any);
        (global as any).fetch = fetchMock;

        const result = await sendNotification(
          'whatsapp',
          '+15550001111',
          { subject: 'New paid message', messageId: 'abc', amount: 12, txHash: '0x123' },
          () => undefined,
        );

        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://graph.facebook.com/v20.0/phone-id-1/messages');
        expect(options.headers).toMatchObject({ authorization: 'Bearer acct-token' });
      },
    );
  });
});
