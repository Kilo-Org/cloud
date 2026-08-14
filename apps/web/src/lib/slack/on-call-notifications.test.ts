import { afterEach, describe, expect, it, jest } from '@jest/globals';

const WEBHOOK_URL = 'https://hooks.slack.com/services/test/on-call/webhook';

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
});

describe('sendOnCallSlackNotification', () => {
  it('posts text and Block Kit content to the on-call webhook', async () => {
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

    await sendOnCallSlackNotification(notification);

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
    const { sendOnCallSlackNotification } = await loadModule(undefined);

    await expect(sendOnCallSlackNotification({ text: 'Test' })).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[OnCallSlackNotifications] SLACK_ON_CALL_WEBHOOK_URL is not configured; notification skipped'
    );
  });

  it('maps fetch failures to an error that does not expose the webhook URL', async () => {
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
