import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import type * as StoreCreditEmail from '@/lib/credits/store-credit-email';
import type * as CronRoute from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/credits/store-credit-email', () => ({
  dispatchStoreCreditWebTipEmails: jest.fn(),
}));

const dispatch = jest.mocked(
  jest.requireMock<typeof StoreCreditEmail>('@/lib/credits/store-credit-email')
    .dispatchStoreCreditWebTipEmails
);
const { GET } = jest.requireActual<typeof CronRoute>('./route');

beforeEach(() => {
  dispatch.mockClear();
});

describe('store credit email cron authorization', () => {
  it.each([undefined, 'Bearer wrong-secret', 'Basic cron-secret', 'Bearer cron-secret-extra'])(
    'rejects unauthorized callers without claiming or sending email (%s)',
    async authorization => {
      const response = await GET(
        new NextRequest('http://localhost/api/cron/store-credit-web-tip', {
          headers: authorization ? { authorization } : {},
        })
      );
      expect(response.status).toBe(401);
      expect(dispatch).not.toHaveBeenCalled();
    }
  );
});
