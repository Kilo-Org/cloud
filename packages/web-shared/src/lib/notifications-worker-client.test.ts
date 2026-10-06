jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
  NOTIFICATIONS_WORKER_URL: 'https://notifications.test',
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { captureException } from '@sentry/nextjs';
import type { InternalDispatchSpendAlertRequest } from '@kilocode/notifications';
import {
  dispatchLowBalancePush,
  dispatchSecurityFindingPush,
  dispatchSecurityLifecyclePush,
  dispatchSpendAlertPush,
  refreshGlanceableScope,
} from './notifications-worker-client';

const fetchMock = jest.fn();

function okResponse(perRecipient: { userId: string; outcome: string }[] = []) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '',
    json: async () => ({ perRecipient }),
  };
}

const spendAlertInput: Omit<InternalDispatchSpendAlertRequest, 'kind'> = {
  recipientUserIds: ['user-1'],
  scope: 'organization',
  organizationId: 'org-1',
  alertKind: 'threshold',
  scopeName: 'Acme',
  amountUsd: 5,
  thresholdUsd: 5,
  dedupeKey: 'org:org-1:threshold:push:2026-01-01T00:00:00.000Z:armed',
};

describe('notifications-worker-client internal dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    // Run the retry backoff synchronously; the schedule itself is covered by
    // the attempt counts asserted below.
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: (...args: never[]) => void
    ) => {
      handler();
      return 0;
    }) as unknown as typeof setTimeout);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts the spend_alert variant to the internal dispatch endpoint', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await expect(dispatchSpendAlertPush(spendAlertInput)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://notifications.test/internal/v1/dispatch');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Secret': 'internal-secret',
      },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      kind: 'spend_alert',
      ...spendAlertInput,
    });
  });

  it('posts every variant under its own kind', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await dispatchLowBalancePush({
      recipientUserIds: ['user-1'],
      organizationId: 'org-1',
      organizationName: 'Acme',
      minimumBalanceUsd: 5,
    });
    await dispatchSpendAlertPush(spendAlertInput);
    await dispatchSecurityFindingPush({
      recipientUserId: 'user-1',
      notificationId: 'notification-1',
      findingId: 'finding-1',
      scope: 'org-1',
      notificationKind: 'new_finding',
      severity: 'high',
      repoFullName: 'acme/repo',
      title: 'Prototype pollution',
    });
    await dispatchSecurityLifecyclePush({
      event: 'analysis_completed',
      findingId: 'finding-1',
      scope: 'org-1',
      recipientUserIds: ['user-1'],
    });

    expect(
      fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body as string).kind)
    ).toEqual(['low_balance', 'spend_alert', 'security_finding', 'security_lifecycle']);
  });

  it('never rejects when the worker call fails', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(dispatchSpendAlertPush(spendAlertInput)).resolves.toBe(false);

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.objectContaining({ kind: 'spend_alert' }) })
    );
  });

  it('never rejects when the worker rejects the dispatch', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    });

    await expect(dispatchSpendAlertPush(spendAlertInput)).resolves.toBe(false);

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ status: 500, kind: 'spend_alert' }),
      })
    );
  });

  it('treats a per-recipient failure inside a 200 body as a refused dispatch, capturing only after the bounded retries are exhausted', async () => {
    fetchMock.mockResolvedValue(
      okResponse([
        { userId: 'user-1', outcome: 'delivered' },
        { userId: 'user-2', outcome: 'failed' },
      ])
    );

    // The worker answers 200 with a per-recipient breakdown even when a push
    // failed inside it; the spend-alert outbox retries on this boolean. The
    // persistent partial failure is retried in-call first, and only the
    // exhausted retry reaches Sentry.
    await expect(dispatchSpendAlertPush(spendAlertInput)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({
          kind: 'spend_alert',
          failedRecipients: 1,
          totalRecipients: 2,
          attempts: 3,
        }),
      })
    );
  });

  it('captures without an in-call retry when every recipient fails', async () => {
    fetchMock.mockResolvedValue(
      okResponse([
        { userId: 'user-1', outcome: 'failed' },
        { userId: 'user-2', outcome: 'failed' },
      ])
    );

    await expect(dispatchSpendAlertPush(spendAlertInput)).resolves.toBe(false);

    // All-fail points at the worker or Expo, not one transient send: alert on
    // the first response instead of retrying inside the call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({
          kind: 'spend_alert',
          failedRecipients: 2,
          totalRecipients: 2,
        }),
      })
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('retries a partial failure and accepts when the retry delivers', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse([
          { userId: 'user-1', outcome: 'delivered' },
          { userId: 'user-2', outcome: 'failed' },
        ])
      )
      .mockResolvedValueOnce(
        okResponse([
          { userId: 'user-1', outcome: 'duplicate' },
          { userId: 'user-2', outcome: 'delivered' },
        ])
      );

    await expect(dispatchSpendAlertPush(spendAlertInput)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A transient partial failure that recovers is a structured warning, never
    // a Sentry error.
    expect(captureException).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('partially failed'),
      expect.objectContaining({
        kind: 'spend_alert',
        failedRecipients: 1,
        totalRecipients: 2,
        attempt: 1,
      })
    );
  });

  it('accepts a dispatch whose recipients were delivered, suppressed, or had no device', async () => {
    fetchMock.mockResolvedValue(
      okResponse([
        { userId: 'user-1', outcome: 'delivered' },
        { userId: 'user-2', outcome: 'suppressed_preference' },
        { userId: 'user-3', outcome: 'no_tokens' },
        { userId: 'user-4', outcome: 'duplicate' },
      ])
    );

    // A recipient with no deliverable push is not a transport failure: retrying
    // it would never deliver, so the dispatch counts as accepted.
    await expect(dispatchSpendAlertPush(spendAlertInput)).resolves.toBe(true);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('notifications-worker-client glanceable refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('posts the scope to the internal glanceable-refresh endpoint', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await refreshGlanceableScope({ userId: 'user-1', organizationId: 'org-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://notifications.test/internal/v1/glanceable-refresh');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Secret': 'internal-secret',
      },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('sends the personal scope as a null organization', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await refreshGlanceableScope({ userId: 'user-1', organizationId: null });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      userId: 'user-1',
      organizationId: null,
    });
  });

  it('never rejects when the worker call fails', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(
      refreshGlanceableScope({ userId: 'user-1', organizationId: null })
    ).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ endpoint: 'glanceable-refresh' }),
      })
    );
  });

  it('never rejects when the worker rejects the refresh', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    });

    await expect(
      refreshGlanceableScope({ userId: 'user-1', organizationId: null })
    ).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ endpoint: 'glanceable-refresh' }),
        extra: expect.objectContaining({ status: 500 }),
      })
    );
  });
});
