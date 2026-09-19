jest.mock('@/lib/config.server', () => ({
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
} from './notifications-worker-client';

const fetchMock = jest.fn();

function okResponse() {
  return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
}

const spendAlertInput: Omit<InternalDispatchSpendAlertRequest, 'kind'> = {
  recipientUserIds: ['user-1'],
  scope: 'organization',
  organizationId: 'org-1',
  alertKind: 'threshold',
  scopeName: 'Acme',
  amountUsd: 5,
  thresholdUsd: 5,
};

describe('notifications-worker-client internal dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
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
});
