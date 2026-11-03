import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { registerStepUpHandler } from '@/lib/trpc/step-up-link';
import { AdminStepUpCancelledError, adminFetch } from './admin-fetch';

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const stepUp403 = (code: string) =>
  new Response(JSON.stringify({ success: false, error: code }), { status: 403 });

afterEach(() => {
  registerStepUpHandler(null);
  jest.restoreAllMocks();
});

describe('adminFetch', () => {
  it('verifies and retries an MFA refusal exactly once', async () => {
    const handler = jest.fn(async (_requirement: unknown) => true);
    registerStepUpHandler(handler);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(stepUp403('MFA_REQUIRED'))
      .mockResolvedValueOnce(ok());

    const response = await adminFetch('/admin/api/users');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith({ code: 'MFA_REQUIRED' });
  });

  it('throws a tagged cancellation so query retry can be suppressed', async () => {
    registerStepUpHandler(async () => false);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(stepUp403('MFA_EXPIRED'));

    const error: unknown = await adminFetch('/admin/api/users').then(
      () => null,
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(AdminStepUpCancelledError);
    expect((error as AdminStepUpCancelledError).data.stepUp.code).toBe('MFA_EXPIRED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a bearer refusal untouched', async () => {
    const handler = jest.fn(async (_requirement: unknown) => true);
    registerStepUpHandler(handler);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(stepUp403('BEARER_NOT_ALLOWED'));

    const response = await adminFetch('/admin/api/users');

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves a non-step-up error untouched', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 403 }));

    const response = await adminFetch('/admin/api/users');

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
