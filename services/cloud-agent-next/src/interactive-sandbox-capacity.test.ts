import { describe, expect, it, vi } from 'vitest';
import {
  decideInteractiveSandboxAllocation,
  resolveInteractiveSandboxCapacity,
  type InteractiveSandboxCapacityInput,
} from './interactive-sandbox-capacity.js';

const userId = 'test-user-123';

function eligibleInput(
  overrides: Partial<InteractiveSandboxCapacityInput> = {}
): InteractiveSandboxCapacityInput {
  return { createdOnPlatform: 'cloud-agent-web', ...overrides };
}

describe('decideInteractiveSandboxAllocation', () => {
  it.each([0, 1, 2] as const)(
    'injects an isolated single sandbox for an eligible create with count %s',
    count => {
      expect(decideInteractiveSandboxAllocation(eligibleInput(), count)).toEqual({
        kind: 'inject',
        sandboxAllocation: 'cloudflare-single',
      });
    }
  );

  it.each([3, 4] as const)(
    'injects the shared sandbox for an eligible create at or over the cap with count %s',
    count => {
      expect(decideInteractiveSandboxAllocation(eligibleInput(), count)).toEqual({
        kind: 'inject',
        sandboxAllocation: 'cloudflare-shared',
      });
    }
  );

  it('injects the shared sandbox when the count is unavailable', () => {
    expect(decideInteractiveSandboxAllocation(eligibleInput(), 'unavailable')).toEqual({
      kind: 'inject',
      sandboxAllocation: 'cloudflare-shared',
    });
  });

  it.each([0, 2] as const)(
    'leaves an explicit single unchanged below the cap with count %s',
    count => {
      expect(
        decideInteractiveSandboxAllocation(
          eligibleInput({ sandboxAllocation: 'cloudflare-single' }),
          count
        )
      ).toEqual({ kind: 'unchanged' });
    }
  );

  it('rejects an explicit single at the cap', () => {
    expect(
      decideInteractiveSandboxAllocation(
        eligibleInput({ sandboxAllocation: 'cloudflare-single' }),
        3
      )
    ).toEqual({ kind: 'reject' });
  });

  it('leaves an explicit single unchanged when the count is unavailable', () => {
    expect(
      decideInteractiveSandboxAllocation(
        eligibleInput({ sandboxAllocation: 'cloudflare-single' }),
        'unavailable'
      )
    ).toEqual({ kind: 'unchanged' });
  });

  it.each([
    'cloudflare-shared',
    'vercel-small',
    'vercel-large',
    'cloudflare-containers-standard-3',
    'isolated-standard',
  ] as const)('leaves explicit %s unchanged even at the cap', allocation => {
    expect(
      decideInteractiveSandboxAllocation(eligibleInput({ sandboxAllocation: allocation }), 9)
    ).toEqual({ kind: 'unchanged' });
  });

  it.each(['slack', 'github', 'cloud-agent', 'app-builder', undefined] as const)(
    'leaves the %s platform unchanged',
    createdOnPlatform => {
      expect(decideInteractiveSandboxAllocation({ createdOnPlatform }, 0)).toEqual({
        kind: 'unchanged',
      });
    }
  );

  it('leaves devcontainer creates unchanged', () => {
    expect(decideInteractiveSandboxAllocation(eligibleInput({ devcontainer: true }), 0)).toEqual({
      kind: 'unchanged',
    });
  });

  it('leaves code-review billing-origin creates unchanged', () => {
    expect(
      decideInteractiveSandboxAllocation(eligibleInput({ billingOrigin: 'code-review' }), 0)
    ).toEqual({ kind: 'unchanged' });
  });

  it('leaves bot sessions unchanged', () => {
    expect(decideInteractiveSandboxAllocation(eligibleInput({ botId: 'bot_123' }), 0)).toEqual({
      kind: 'unchanged',
    });
  });
});

describe('resolveInteractiveSandboxCapacity', () => {
  it('reads the count once for an eligible create and injects single below the cap', async () => {
    const countOpenSmallSandboxContainers = vi.fn().mockResolvedValue(2);
    const decision = await resolveInteractiveSandboxCapacity(eligibleInput(), {
      userId,
      countOpenSmallSandboxContainers,
    });

    expect(countOpenSmallSandboxContainers).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({ kind: 'inject', sandboxAllocation: 'cloudflare-single' });
  });

  it.each([
    ['non-interactive platform slack', { createdOnPlatform: 'slack' }],
    ['non-interactive platform github', { createdOnPlatform: 'github' }],
    ['non-interactive platform cloud-agent', { createdOnPlatform: 'cloud-agent' }],
    ['non-interactive platform app-builder', { createdOnPlatform: 'app-builder' }],
    ['missing platform', {}],
    ['bot session', eligibleInput({ botId: 'bot_123' })],
    ['devcontainer', eligibleInput({ devcontainer: true })],
    ['code-review', eligibleInput({ billingOrigin: 'code-review' })],
    ['explicit shared', eligibleInput({ sandboxAllocation: 'cloudflare-shared' })],
    ['explicit Vercel small', eligibleInput({ sandboxAllocation: 'vercel-small' })],
    ['explicit Vercel large', eligibleInput({ sandboxAllocation: 'vercel-large' })],
    [
      'explicit cloudflare-containers',
      eligibleInput({ sandboxAllocation: 'cloudflare-containers-standard-3' }),
    ],
    ['explicit isolated standard', eligibleInput({ sandboxAllocation: 'isolated-standard' })],
  ] as const)('does not read the count for %s', async (_label, input) => {
    const countOpenSmallSandboxContainers = vi.fn().mockResolvedValue(9);
    const decision = await resolveInteractiveSandboxCapacity(input, {
      userId,
      countOpenSmallSandboxContainers,
    });

    expect(countOpenSmallSandboxContainers).not.toHaveBeenCalled();
    expect(decision).toEqual({ kind: 'unchanged' });
  });

  it('treats a count-read failure as unavailable and injects shared', async () => {
    const countOpenSmallSandboxContainers = vi
      .fn()
      .mockRejectedValue(new Error('meter database unavailable'));
    const decision = await resolveInteractiveSandboxCapacity(eligibleInput(), {
      userId,
      countOpenSmallSandboxContainers,
    });

    expect(decision).toEqual({ kind: 'inject', sandboxAllocation: 'cloudflare-shared' });
  });

  it('treats a count-read failure as unavailable and leaves an explicit single unchanged', async () => {
    const countOpenSmallSandboxContainers = vi.fn().mockRejectedValue(new Error('boom'));
    const decision = await resolveInteractiveSandboxCapacity(
      eligibleInput({ sandboxAllocation: 'cloudflare-single' }),
      { userId, countOpenSmallSandboxContainers }
    );

    expect(decision).toEqual({ kind: 'unchanged' });
  });

  it('rejects an explicit single at the cap without an injection', async () => {
    const countOpenSmallSandboxContainers = vi.fn().mockResolvedValue(3);
    const decision = await resolveInteractiveSandboxCapacity(
      eligibleInput({ sandboxAllocation: 'cloudflare-single' }),
      { userId, countOpenSmallSandboxContainers }
    );

    expect(countOpenSmallSandboxContainers).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({ kind: 'reject' });
  });
});
