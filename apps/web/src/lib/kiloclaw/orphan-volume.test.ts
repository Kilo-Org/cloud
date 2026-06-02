import { classifyOrphanVolume } from './orphan-volume';

/** A volume that passes every safety check — the `safe_destroy` baseline. */
const SAFE = {
  volumeState: 'created',
  attachedMachineId: null,
  trackedByLiveDo: false,
  doStatus: null,
  doStatusError: null,
  hasAccessGrantingSubscription: false,
  destructionScheduled: false,
  graceElapsed: true,
} as const;

describe('classifyOrphanVolume', () => {
  it('returns safe_destroy only when every check passes', () => {
    expect(classifyOrphanVolume(SAFE)).toBe('safe_destroy');
  });

  it('classifies created and detached unattached volumes as safe', () => {
    expect(classifyOrphanVolume({ ...SAFE, volumeState: 'created' })).toBe('safe_destroy');
    expect(classifyOrphanVolume({ ...SAFE, volumeState: 'detached' })).toBe('safe_destroy');
  });

  it('refuses when DO state could not be confirmed', () => {
    expect(classifyOrphanVolume({ ...SAFE, doStatusError: 'DO unreachable' })).toBe(
      'do_check_failed'
    );
  });

  it('marks volumes Fly is already reaping', () => {
    for (const volumeState of ['pending_destroy', 'destroying', 'destroyed']) {
      expect(classifyOrphanVolume({ ...SAFE, volumeState })).toBe('fly_reaping');
    }
  });

  it('refuses volumes attached to a machine', () => {
    expect(classifyOrphanVolume({ ...SAFE, attachedMachineId: 'm-123' })).toBe('attached');
    expect(classifyOrphanVolume({ ...SAFE, volumeState: 'attached' })).toBe('attached');
  });

  it('refuses volumes a live DO still tracks', () => {
    expect(classifyOrphanVolume({ ...SAFE, trackedByLiveDo: true, doStatus: 'running' })).toBe(
      'do_tracked'
    );
  });

  it('refuses when the DO is alive even if it does not track this volume', () => {
    expect(classifyOrphanVolume({ ...SAFE, doStatus: 'stopped' })).toBe('do_alive');
  });

  it('refuses when the user has an access-granting subscription', () => {
    expect(classifyOrphanVolume({ ...SAFE, hasAccessGrantingSubscription: true })).toBe(
      'subscription_active'
    );
  });

  it('refuses while a billing destruction deadline is still pending', () => {
    expect(classifyOrphanVolume({ ...SAFE, destructionScheduled: true })).toBe(
      'destruction_scheduled'
    );
  });

  it('refuses while the instance is still inside the grace period', () => {
    expect(classifyOrphanVolume({ ...SAFE, graceElapsed: false })).toBe('within_grace');
  });

  describe('precedence — the strongest refusal reason wins', () => {
    it('do_check_failed outranks every other signal', () => {
      expect(
        classifyOrphanVolume({
          volumeState: 'attached',
          attachedMachineId: 'm-1',
          trackedByLiveDo: true,
          doStatus: 'running',
          doStatusError: 'unreachable',
          hasAccessGrantingSubscription: true,
          destructionScheduled: true,
          graceElapsed: false,
        })
      ).toBe('do_check_failed');
    });

    it('fly_reaping outranks attached / do / subscription / grace', () => {
      expect(
        classifyOrphanVolume({
          ...SAFE,
          volumeState: 'destroying',
          attachedMachineId: 'm-1',
          trackedByLiveDo: true,
          hasAccessGrantingSubscription: true,
          graceElapsed: false,
        })
      ).toBe('fly_reaping');
    });

    it('attached outranks a live-DO reference', () => {
      expect(
        classifyOrphanVolume({
          ...SAFE,
          attachedMachineId: 'm-1',
          trackedByLiveDo: true,
          doStatus: 'running',
        })
      ).toBe('attached');
    });

    it('do_tracked outranks do_alive', () => {
      expect(classifyOrphanVolume({ ...SAFE, trackedByLiveDo: true, doStatus: 'recovering' })).toBe(
        'do_tracked'
      );
    });

    it('subscription_active outranks destruction_scheduled and within_grace', () => {
      expect(
        classifyOrphanVolume({
          ...SAFE,
          hasAccessGrantingSubscription: true,
          destructionScheduled: true,
          graceElapsed: false,
        })
      ).toBe('subscription_active');
    });

    it('destruction_scheduled outranks within_grace', () => {
      expect(
        classifyOrphanVolume({
          ...SAFE,
          destructionScheduled: true,
          graceElapsed: false,
        })
      ).toBe('destruction_scheduled');
    });
  });
});
