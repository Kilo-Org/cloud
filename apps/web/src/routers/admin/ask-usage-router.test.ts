import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { createCallerFactory } from '@/lib/trpc/init';

const mockStartAskUsageSession =
  jest.fn<
    (params: {
      user: User;
      input?: { model?: string; variant?: string };
    }) => Promise<{ kiloSessionId: string }>
  >();

jest.mock('@/modules/ask-usage/server/start-ask-usage-session', () => ({
  startAskUsageSession: mockStartAskUsageSession,
}));

let createCaller: (ctx: { user: User }) => {
  start: (input?: { model?: string; variant?: string }) => Promise<{ kiloSessionId: string }>;
};

beforeAll(async () => {
  const mod = await import('./ask-usage-router');
  createCaller = createCallerFactory(mod.adminAskUsageRouter);
});

describe('adminAskUsageRouter.start', () => {
  it('validates input and delegates to startAskUsageSession', async () => {
    const user = { id: 'user-1', is_admin: true } as User;
    mockStartAskUsageSession.mockResolvedValue({ kiloSessionId: 'ses_12345678901234567890123456' });

    await expect(
      createCaller({ user }).start({ model: ' anthropic/claude ', variant: ' low ' })
    ).resolves.toEqual({ kiloSessionId: 'ses_12345678901234567890123456' });

    expect(mockStartAskUsageSession).toHaveBeenCalledWith({
      user,
      input: { model: 'anthropic/claude', variant: 'low' },
    });
  });
});
