import { describe, expect, it } from '@jest/globals';
import { after, NextRequest } from 'next/server';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { sendBalanceAlertEmail } from '@kilocode/web-shared/lib/email';
import { dispatchLowBalancePush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { POST } from './route';

jest.mock('next/server', () => ({ ...jest.requireActual('next/server'), after: jest.fn() }));

jest.mock('@kilocode/web-shared/lib/email', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/email'),
  sendBalanceAlertEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  dispatchLowBalancePush: jest.fn().mockResolvedValue(undefined),
}));

function request(body: unknown, secret = INTERNAL_API_SECRET) {
  return new NextRequest('http://localhost/api/internal/organizations/compute-balance-alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
    body: JSON.stringify(body),
  });
}

describe('internal organization compute balance alert', () => {
  it('requires service authentication and a valid organization ID', async () => {
    expect((await POST(request({ organizationId: crypto.randomUUID() }, 'wrong'))).status).toBe(
      401
    );
    expect((await POST(request({ organizationId: 'invalid' }))).status).toBe(400);
    expect(sendBalanceAlertEmail).not.toHaveBeenCalled();
  });

  it('uses the existing email and push delivery with configured recipients', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Compute alert recipients', user.id, 1_000_000, {
      minimum_balance: 18,
      minimum_balance_alert_email: [user.google_user_email],
    });
    expect((await POST(request({ organizationId: org.id }))).status).toBe(200);
    expect(sendBalanceAlertEmail).not.toHaveBeenCalled();
    const task = jest.mocked(after).mock.calls[0]?.[0];
    expect(typeof task).toBe('function');
    if (typeof task !== 'function') throw new Error('Missing deferred alert');
    await task();
    expect(sendBalanceAlertEmail).toHaveBeenCalledWith({
      organizationId: org.id,
      minimum_balance: 18,
      to: [user.google_user_email],
    });
    expect(dispatchLowBalancePush).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org.id,
        recipientUserIds: [user.id],
        minimumBalanceUsd: 18,
      })
    );
  });
});
