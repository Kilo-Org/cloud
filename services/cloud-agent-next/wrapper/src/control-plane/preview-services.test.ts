import { describe, expect, it } from 'bun:test';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import {
  PreviewServiceScanTimeoutError,
  type PreviewServiceScanOptions,
} from '../control/preview-services.js';
import {
  createControlPlanePreviewServices,
  type ControlPlanePreviewServicesDeps,
} from './preview-services.js';

function harness(overrides: Partial<ControlPlanePreviewServicesDeps> = {}) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const logs: string[] = [];
  const scans: PreviewServiceScanOptions[] = [];
  const adapter = createControlPlanePreviewServices({
    emit: frame => frames.push(frame),
    log: message => logs.push(message),
    scan: async options => {
      scans.push(options);
      return [{ port: 3001, name: 'Next.js' }];
    },
    ...overrides,
  });
  return { adapter, frames, logs, scans };
}

const frame = { type: 'preview.list' as const, requestId: 'req-1' };

describe('control-plane preview discovery transport', () => {
  it('returns the scanned services', async () => {
    const { adapter, frames, scans } = harness({
      procRoot: '/tmp/proc',
      excludedPorts: [3000],
    });

    await adapter.handle(frame);

    expect(frames).toEqual([
      {
        type: 'preview.result',
        requestId: 'req-1',
        ok: true,
        result: { services: [{ port: 3001, name: 'Next.js' }] },
      },
    ]);
    expect(scans[0]?.procRoot).toBe('/tmp/proc');
    expect(scans[0]?.excludedPorts).toEqual([3000]);
    expect(scans[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a scan failure as an error instead of an empty list', async () => {
    const { adapter, frames, logs } = harness({
      scan: async () => {
        throw new Error('permission denied while reading /proc/1/fd');
      },
    });

    await adapter.handle(frame);

    expect(frames).toEqual([
      {
        type: 'preview.result',
        requestId: 'req-1',
        ok: false,
        error: {
          code: 'scan_failed',
          message: 'Preview service discovery failed',
          retryable: true,
        },
      },
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('permission denied');
  });

  it('reports a timeout as retryable', async () => {
    const { adapter, frames } = harness({
      scan: async () => {
        throw new PreviewServiceScanTimeoutError();
      },
    });

    await adapter.handle(frame);

    expect(frames).toEqual([
      {
        type: 'preview.result',
        requestId: 'req-1',
        ok: false,
        error: {
          code: 'timeout',
          message: 'Preview service discovery timed out',
          retryable: true,
        },
      },
    ]);
  });

  it('aborts a slow scan at the request bound', async () => {
    const { adapter, frames } = harness({
      timeoutMs: 10,
      scan: options =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });

    await adapter.handle(frame);

    expect(frames).toEqual([
      {
        type: 'preview.result',
        requestId: 'req-1',
        ok: false,
        error: {
          code: 'timeout',
          message: 'Preview service discovery timed out',
          retryable: true,
        },
      },
    ]);
  });

  it('rejects a scan result that violates the public contract', async () => {
    const { adapter, frames } = harness({
      scan: async () => [{ port: 80, name: 'HTTP server' }],
    });

    await adapter.handle(frame);

    expect(frames[0]).toMatchObject({
      type: 'preview.result',
      requestId: 'req-1',
      ok: false,
      error: { code: 'scan_failed' },
    });
  });
});
