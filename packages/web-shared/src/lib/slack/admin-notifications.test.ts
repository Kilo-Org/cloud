import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { AdminSlackNotificationError } from './admin-notifications';

const WEBHOOK_URL = 'https://hooks.slack.com/services/test/webhook/url';

async function loadModule(webhookUrl: string | undefined) {
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
    SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL: webhookUrl,
  }));
  return import('./admin-notifications');
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.dontMock('@kilocode/web-shared/lib/config.server');
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

  it('maps a body-read failure to the same network error', async () => {
    const bodyFailure = new Response('ok', { status: 200 });
    jest
      .spyOn(bodyFailure, 'text')
      .mockRejectedValue(new Error(`Connection lost for ${WEBHOOK_URL}`));
    jest.spyOn(global, 'fetch').mockResolvedValue(bodyFailure);
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

describe('AdminSlackNotificationError variants', () => {
  it('carries a status only on the upstream variant', () => {
    const upstream = new AdminSlackNotificationError('upstream', 429);
    expect(upstream.kind).toBe('upstream');
    expect(upstream.status).toBe(429);
    expect(upstream.name).toBe('AdminSlackNotificationError');
    expect(upstream.message).toBe('Admin Slack notification request failed');
    expect(upstream).toBeInstanceOf(Error);

    for (const kind of ['configuration', 'network'] as const) {
      const other = new AdminSlackNotificationError(kind);
      expect(other.kind).toBe(kind);
      expect(other.status).toBeUndefined();
    }
  });

  it('does not type a status on the kinds that never carry one', () => {
    // These cases exist for the compiler: the package typecheck fails if any of
    // them stops being a type error. The runtime assertions only prove the
    // class stays constructible when a JavaScript caller ignores the types.
    // @ts-expect-error configuration has no status
    const configurationWithStatus = new AdminSlackNotificationError('configuration', 500);
    // @ts-expect-error network has no status
    const networkWithStatus = new AdminSlackNotificationError('network', 500);
    // @ts-expect-error upstream requires its status
    const upstreamWithoutStatus = new AdminSlackNotificationError('upstream');

    expect(configurationWithStatus.kind).toBe('configuration');
    expect(networkWithStatus.kind).toBe('network');
    expect(upstreamWithoutStatus.kind).toBe('upstream');
  });

  it('narrows the upstream status to a number', () => {
    const error: unknown = new AdminSlackNotificationError('upstream', 500);
    if (error instanceof AdminSlackNotificationError && error.kind === 'upstream') {
      const status: number = error.status;
      expect(status).toBe(500);
    } else {
      throw new Error('expected an upstream AdminSlackNotificationError');
    }
  });
});
