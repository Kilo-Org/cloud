import { afterEach, describe, expect, it, jest } from '@jest/globals';

const WEBHOOK_URL = 'https://hooks.slack.com/services/test/webhook/url';

async function loadModule(webhookUrl: string | undefined) {
  jest.resetModules();
  jest.doMock('@/lib/config.server', () => ({
    SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL: webhookUrl,
  }));
  return import('./admin-notifications');
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.dontMock('@/lib/config.server');
});

describe('sendAdminSlackNotification', () => {
  it('posts text and Block Kit content to the configured webhook', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const { sendAdminSlackNotification } = await loadModule(WEBHOOK_URL);
    const notification = {
      text: 'Daily admin summary',
      blocks: [
        {
          type: 'section' as const,
          text: { type: 'mrkdwn' as const, text: '*Daily admin summary*' },
        },
      ],
      unfurl_links: false,
    };

    await sendAdminSlackNotification(notification);

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

  it('logs a warning and skips delivery when the webhook is not configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sendAdminSlackNotification } = await loadModule(undefined);

    await expect(sendAdminSlackNotification({ text: 'Test' })).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[AdminSlackNotifications] SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL is not configured; notification skipped'
    );
  });

  it('fails when a caller requires a configured webhook', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const { sendAdminSlackNotification } = await loadModule(undefined);

    await expect(
      sendAdminSlackNotification({ text: 'Test' }, { requireConfigured: true })
    ).rejects.toMatchObject({ kind: 'configuration' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws an upstream error when Slack rejects the request', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('invalid_payload', { status: 400 }));
    const { sendAdminSlackNotification } = await loadModule(WEBHOOK_URL);

    await expect(sendAdminSlackNotification({ text: 'Test' })).rejects.toMatchObject({
      kind: 'upstream',
      status: 400,
    });
  });

  it('maps fetch failures to an error that does not expose the webhook URL', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error(`Could not reach ${WEBHOOK_URL}`));
    const { sendAdminSlackNotification } = await loadModule(WEBHOOK_URL);

    let error: unknown;
    try {
      await sendAdminSlackNotification({ text: 'Test' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ kind: 'network' });
    expect(String(error)).not.toContain(WEBHOOK_URL);
  });
});
