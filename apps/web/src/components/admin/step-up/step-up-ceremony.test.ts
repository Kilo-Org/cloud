import { describe, expect, it, jest } from '@jest/globals';
import { StepUpCancelledError } from './step-up-error';
import { runStepUpCeremony, runWithStepUp } from './step-up-ceremony';
import { StepUpRequestQueue } from './step-up-requests';

describe('runStepUpCeremony', () => {
  const options = { challenge: 'stored-challenge' } as never;
  it('verifies once with the minted options', async () => {
    const submitAssertion = jest.fn(async (_challengeId: string, _response: unknown) => true);
    const enroll = jest.fn(async () => {});

    const result = await runStepUpCeremony({
      requestOptions: async () => ({ ok: true, challengeId: 'c1', options }),
      startAuthentication: async () => ({ id: 'assertion' }),
      submitAssertion,
      enroll,
    });

    expect(result).toEqual({ ok: true });
    expect(submitAssertion).toHaveBeenCalledWith('c1', { id: 'assertion' });
    expect(enroll).not.toHaveBeenCalled();
  });

  it('enrolls once and mints options again when no passkey exists', async () => {
    const requestOptions = jest
      .fn<
        () => Promise<
          { ok: true; challengeId: string; options: never } | { ok: false; code: string }
        >
      >()
      .mockResolvedValueOnce({ ok: false, code: 'NOT_ENROLLED' })
      .mockResolvedValueOnce({ ok: true, challengeId: 'c2', options });
    const enroll = jest.fn(async () => {});

    const result = await runStepUpCeremony({
      requestOptions,
      startAuthentication: async () => ({}),
      submitAssertion: async () => true,
      enroll,
    });

    expect(result).toEqual({ ok: true });
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(requestOptions).toHaveBeenCalledTimes(2);
  });

  it('treats a cancelled passkey sheet as terminal and does not retry', async () => {
    const requestOptions = jest.fn(async () => ({ ok: true as const, challengeId: 'c1', options }));
    const submitAssertion = jest.fn(async (_challengeId: string, _response: unknown) => true);

    const result = await runStepUpCeremony({
      requestOptions,
      startAuthentication: async () => {
        throw new Error('NotAllowedError');
      },
      submitAssertion,
      enroll: async () => {},
    });

    expect(result).toEqual({ ok: false, code: 'CANCELLED' });
    expect(requestOptions).toHaveBeenCalledTimes(1);
    expect(submitAssertion).not.toHaveBeenCalled();
  });

  it('surfaces a refusal code without retrying', async () => {
    const result = await runStepUpCeremony({
      requestOptions: async () => ({ ok: false, code: 'SESSION_UNBOUND' }),
      startAuthentication: async () => ({}),
      submitAssertion: async () => true,
      enroll: async () => {},
    });

    expect(result).toEqual({ ok: false, code: 'SESSION_UNBOUND' });
  });
});

describe('runWithStepUp', () => {
  const requirement = { code: 'MFA_REQUIRED' as const };

  it('retries the operation exactly once after verification', async () => {
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ data: { stepUp: requirement } })
      .mockResolvedValueOnce('done');
    const requestStepUp = jest.fn(async () => true);

    await expect(
      runWithStepUp(
        operation,
        requestStepUp,
        error => (error as { data?: { stepUp?: typeof requirement } }).data?.stepUp ?? null
      )
    ).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the dialog is cancelled', async () => {
    const operation = jest.fn<() => Promise<string>>().mockRejectedValue({
      data: { stepUp: requirement },
    });

    await expect(
      runWithStepUp(
        operation,
        async () => false,
        error => (error as { data?: { stepUp?: typeof requirement } }).data?.stepUp ?? null
      )
    ).rejects.toBeInstanceOf(StepUpCancelledError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error without a step-up requirement', async () => {
    const operation = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('boom'));
    const requestStepUp = jest.fn(async () => true);

    await expect(runWithStepUp(operation, requestStepUp, () => null)).rejects.toThrow('boom');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(requestStepUp).not.toHaveBeenCalled();
  });
});

describe('StepUpRequestQueue', () => {
  it('settles an earlier request as cancelled when a second request begins', async () => {
    const queue = new StepUpRequestQueue();
    const first = queue.begin();
    const second = queue.begin();

    await expect(first).resolves.toBe(false);
    queue.settle(true);
    await expect(second).resolves.toBe(true);
  });

  it('settles a pending request only once', async () => {
    const queue = new StepUpRequestQueue();
    const pending = queue.begin();
    queue.settle(false);
    queue.settle(true);
    await expect(pending).resolves.toBe(false);
  });
});
