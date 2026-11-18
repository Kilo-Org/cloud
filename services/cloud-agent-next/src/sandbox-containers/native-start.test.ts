import { describe, expect, it } from 'vitest';
import { CONTROL_SUPERVISOR_PATH } from '../sandbox-control/container-paths.js';
import { planNativeStart } from './native-start.js';
import { captureResult, retainCaptureIds, MAX_RETAINED_CAPTURES } from './native-capture.js';

const REQUEST = {
  image: 'registry.example/app:1',
  instance: 'standard-3' as const,
  mainProcess: 'supervisor' as const,
  command: { argv: ['/bin/sh', CONTROL_SUPERVISOR_PATH] },
  env: { A: '1' },
  interception: false,
};

describe('planNativeStart', () => {
  it('uses a snapshot only when allowed and captured from the same image', () => {
    const snapshot = { snapshotId: 'snap-1', baseImage: 'registry.example/app:1' };
    expect(planNativeStart({ ...REQUEST, snapshot }, true)).toMatchObject({
      source: 'repository',
      snapshotId: 'snap-1',
      reason: 'snapshot',
      options: { containerSnapshot: { id: 'snap-1' } },
    });
    expect(planNativeStart({ ...REQUEST, snapshot }, false).reason).toBe('not_allowed');
    expect(
      planNativeStart({ ...REQUEST, snapshot: { ...snapshot, baseImage: 'other' } }, true)
    ).toMatchObject({
      source: 'image',
      reason: 'image_mismatch',
      options: { image: REQUEST.image },
    });
    expect(planNativeStart(REQUEST, true).reason).toBe('no_snapshot');
  });

  it('preserves the supplied runtime command and adds interception without dropping caller env', () => {
    const plan = planNativeStart(
      {
        ...REQUEST,
        interception: true,
        egressAllowlist: ['example.com'],
        command: { argv: ['/bin/sh', '-c', 'download-and-exec'] },
      },
      true
    );
    expect(plan.options.enableInternet).toBe(false);
    expect(plan.options.entrypoint).toEqual(['/bin/sh', '-c', 'download-and-exec']);
    expect(plan.options.env).toMatchObject({
      A: '1',
      SANDBOX_INTERCEPT_HTTPS: '1',
      CONTROL_PLANE_NATIVE_LOGS: '1',
    });
  });

  it('runs the current runtime installer when restoring a snapshot', () => {
    const command = { argv: ['/bin/sh', '-c', 'install-current-runtime-and-exec'] };
    const plan = planNativeStart(
      { ...REQUEST, command, snapshot: { snapshotId: 'old-runtime', baseImage: REQUEST.image } },
      true
    );
    expect(plan.source).toBe('repository');
    expect(plan.options.containerSnapshot).toEqual({ id: 'old-runtime' });
    expect(plan.options.entrypoint).toEqual(command.argv);
  });
});

describe('native capture records', () => {
  it('maps an issued record to in progress only while its call runs', () => {
    const issued = { state: 'issued' as const, allocationRef: 'a', issuedAt: 1 };
    expect(captureResult(issued, true)).toEqual({ status: 'in_progress' });
    expect(captureResult(issued, false)).toEqual({ status: 'failed', reason: 'uncertain' });
  });

  it('keeps the newest captures and evicts the rest', () => {
    const index = Array.from({ length: MAX_RETAINED_CAPTURES }, (_, i) => `c${i}`);
    expect(retainCaptureIds(index, 'new')).toEqual({
      index: ['new', ...index.slice(0, MAX_RETAINED_CAPTURES - 1)],
      evicted: [`c${MAX_RETAINED_CAPTURES - 1}`],
    });
    expect(retainCaptureIds(['a', 'b'], 'b')).toEqual({ index: ['b', 'a'], evicted: [] });
  });
});
