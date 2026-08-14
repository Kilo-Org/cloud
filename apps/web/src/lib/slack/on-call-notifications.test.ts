import { afterEach, describe, expect, it, jest } from '@jest/globals';

const WEBHOOK_URL = 'https://hooks.slack.com/services/test/on-call/webhook';
const originalVercelEnv = process.env.VERCEL_ENV;

async function loadModule(webhookUrl: string | undefined) {
  jest.resetModules();
  jest.doMock('@/lib/config.server', () => ({
    SLACK_ON_CALL_WEBHOOK_URL: webhookUrl,
  }));
  return import('./on-call-notifications');
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.dontMock('@/lib/config.server');
  process.env.VERCEL_ENV = originalVercelEnv;
});

describe('sendOnCallSlackNotification', () => {
  it('posts text and Block Kit content to the on-call webhook', async () => {
    process.env.VERCEL_ENV = 'production';
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const { sendOnCallSlackNotification } = await loadModule(WEBHOOK_URL);
    const notification = {
      text: 'Stale sync-providers alert',
      blocks: [
        {
          type: 'section' as const,
          text: { type: 'mrkdwn' as const, text: '*Stale sync-providers alert*' },
        },
      ],
      unfurl_links: false,
    };

    await expect(sendOnCallSlackNotification(notification)).resolves.toBe('posted');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      WEBHOOK_URL,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(notification),
      })
    );
  });

  it('simulates delivery outside production Vercel even when a webhook is configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const { sendOnCallSlackNotification } = await loadModule(WEBHOOK_URL);

    await expect(sendOnCallSlackNotification({ text: 'Test' })).resolves.toBe('simulated');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[OnCallSlackNotifications] Simulated notification; Slack delivery is enabled only on production Vercel',
      { text: 'Test' }
    );
  });

  it('fails in production Vercel when the webhook is not configured', async () => {
    process.env.VERCEL_ENV = 'production';
    const fetchSpy = jest.spyOn(global, 'fetch');
    const { sendOnCallSlackNotification } = await loadModule(undefined);

    await expect(sendOnCallSlackNotification({ text: 'Test' })).rejects.toMatchObject({
      kind: 'configuration',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps fetch failures to an error that does not expose the webhook URL', async () => {
    process.env.VERCEL_ENV = 'production';
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error(`Could not reach ${WEBHOOK_URL}`));
    const { sendOnCallSlackNotification } = await loadModule(WEBHOOK_URL);

    let error: unknown;
    try {
      await sendOnCallSlackNotification({ text: 'Test' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ kind: 'network' });
    expect(String(error)).not.toContain(WEBHOOK_URL);
  });
});
