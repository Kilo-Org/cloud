jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-test-secret',
  KILOCLAW_API_URL: 'https://claw.test',
}));

import { KiloClawInternalClient } from './kiloclaw-internal-client';

describe('KiloClawInternalClient.destroy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the complete worker finalization response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          finalized: false,
          destroyedUserId: null,
          destroyedSandboxId: null,
          pendingMachineId: null,
          pendingVolumeId: 'vol-1',
          lastDestroyErrorOp: 'volume',
          lastDestroyErrorStatus: 412,
          lastDestroyErrorAt: 1_777_777_777,
        }),
        { status: 200 }
      )
    );
    await expect(
      new KiloClawInternalClient().destroy('user-1', '11111111-1111-4111-8111-111111111111')
    ).resolves.toMatchObject({ ok: true, finalized: false, pendingVolumeId: 'vol-1' });
  });
});
