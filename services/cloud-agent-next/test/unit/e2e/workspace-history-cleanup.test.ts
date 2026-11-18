import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneKiloRuntime } from '../../e2e/sandbox-control.js';

const { discover, stop, wait } = vi.hoisted(() => ({
  discover: vi.fn(),
  stop: vi.fn(),
  wait: vi.fn(),
}));

vi.mock('../../e2e/sandbox-control.js', () => ({
  findControlPlaneKiloRuntime: discover,
  stopOwnedControlPlaneSandbox: stop,
  waitForSandboxFamilyGone: wait,
}));

import { stopOwnedSandboxes } from '../../e2e/workspace-history.js';

function runtime(id: string): ControlPlaneKiloRuntime {
  return {
    container: { id, name: id, image: 'test', isProxy: false },
    kiloSessionId: `ses_${id}`,
    serverUrl: 'http://127.0.0.1:4096',
    directory: `/workspace/${id}`,
    home: `/home/${id}`,
    processId: 42,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  discover.mockImplementation(async (id: string) => runtime(id));
  stop.mockImplementation(async (container: { id: string }) => [container.id]);
  wait.mockResolvedValue(true);
});

describe('workspace history sandbox cleanup', () => {
  it.each(['discovery', 'stop', 'confirmation'])(
    'attempts remaining sandboxes after a %s failure and reports the failure',
    async stage => {
      const failure = new Error('cleanup failed');
      if (stage === 'discovery') discover.mockRejectedValueOnce(failure);
      if (stage === 'stop') stop.mockRejectedValueOnce(failure);
      if (stage === 'confirmation') wait.mockResolvedValueOnce(false);
      await expect(
        stopOwnedSandboxes([
          ['workspace_first', 'first'],
          ['workspace_second', 'second'],
        ])
      ).rejects.toBeInstanceOf(AggregateError);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledWith(
        runtime('second').container,
        'ses_second',
        undefined,
        expect.arrayContaining(['/workspace/second'])
      );
      expect(wait).toHaveBeenCalledWith(runtime('second').container, 15_000);
    }
  );

  it('stops each shared container once and waits for all independent cleanup attempts', async () => {
    discover.mockResolvedValueOnce(runtime('first')).mockResolvedValueOnce(runtime('first'));
    expect(
      await stopOwnedSandboxes([
        ['workspace_first', 'first'],
        ['workspace_second', 'second'],
      ])
    ).toEqual(['first']);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
