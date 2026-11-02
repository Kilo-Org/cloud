import { describe, expect, it, jest } from '@jest/globals';
import { runStepUpCeremony } from './step-up-ceremony';
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
        throw Object.assign(new Error('user dismissed'), { name: 'NotAllowedError' });
      },
      submitAssertion,
      enroll: async () => {},
    });

    expect(result).toEqual({ ok: false, code: 'CANCELLED' });
    expect(requestOptions).toHaveBeenCalledTimes(1);
    expect(submitAssertion).not.toHaveBeenCalled();
  });

  it('reports a non-cancellation browser error as a verification failure', async () => {
    const result = await runStepUpCeremony({
      requestOptions: async () => ({ ok: true, challengeId: 'c1', options }),
      startAuthentication: async () => {
        throw Object.assign(new Error('authenticator unavailable'), { name: 'InvalidStateError' });
      },
      submitAssertion: async () => true,
      enroll: async () => {},
    });

    expect(result).toEqual({ ok: false, code: 'VERIFICATION_FAILED' });
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
