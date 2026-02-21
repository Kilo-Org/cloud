import { describe, it, expect, vi } from 'vitest';
import {
  FlyApiError,
  isFlyNotFound,
  isFlyInsufficientResources,
  createMachine,
  createVolumeWithFallback,
  listVolumeSnapshots,
} from './client';
import type { FlyClientConfig } from './client';

describe('isFlyNotFound', () => {
  it('returns true for FlyApiError with status 404', () => {
    const err = new FlyApiError('not found', 404, '{}');
    expect(isFlyNotFound(err)).toBe(true);
  });

  it('returns false for FlyApiError with non-404 status', () => {
    const err = new FlyApiError('server error', 500, '{}');
    expect(isFlyNotFound(err)).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isFlyNotFound(new Error('something'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFlyNotFound('string')).toBe(false);
    expect(isFlyNotFound(null)).toBe(false);
    expect(isFlyNotFound(undefined)).toBe(false);
    expect(isFlyNotFound(42)).toBe(false);
  });
});

describe('isFlyInsufficientResources', () => {
  // -- Confirmed production payload --

  it('matches production payload: insufficient resources + existing volume', () => {
    const body =
      '{"error":"insufficient resources to create new machine with existing volume \'vol_4y5gkog8p5kj839r\'"}';
    const err = new FlyApiError(`Fly API createMachine failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches capacity marker case-insensitively', () => {
    const body = '{"error":"Insufficient Resources for volume"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches capacity marker in non-JSON body text', () => {
    const body = 'insufficient resources to create machine';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  // -- Confirmed production 409 payload --

  it('matches production 409 payload: insufficient memory on updateMachine', () => {
    const body =
      '{"error":"aborted: could not reserve resource for machine: insufficient memory available to fulfill request"}';
    const err = new FlyApiError(`Fly API updateMachine failed (409): ${body}`, 409, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  // -- Non-capacity 409s: must NOT trigger recovery --

  it('returns false for non-capacity 409 conflicts', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const body = '{"error":"conflict: machine is already being updated"}';
    const err = new FlyApiError(`Fly API failed (409): ${body}`, 409, body);
    expect(isFlyInsufficientResources(err)).toBe(false);

    warnSpy.mockRestore();
  });

  // -- Version/precondition 412s: must NOT trigger recovery --

  it('returns false for version/precondition 412s', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // These are hypothetical but represent the class of 412s we must NOT match
    const preconditionBodies = [
      '{"error":"min_secrets_version 3 is not yet available on this app"}',
      '{"error":"machine_version mismatch: expected 5, got 4"}',
      '{"error":"precondition failed: current_version does not match"}',
    ];

    for (const body of preconditionBodies) {
      const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
      expect(isFlyInsufficientResources(err)).toBe(false);
    }

    warnSpy.mockRestore();
  });

  // -- Unclassified 409/412: should return false and warn --

  it('returns false and logs warning for unclassified 412', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = '{"error":"some unknown 412 reason"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);

    expect(isFlyInsufficientResources(err)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[fly] Unclassified 412 error (not treated as capacity):',
      body
    );
    warnSpy.mockRestore();
  });

  it('returns false and logs warning for unclassified 409', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = '{"error":"some unknown 409 reason"}';
    const err = new FlyApiError(`Fly API failed (409): ${body}`, 409, body);

    expect(isFlyInsufficientResources(err)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[fly] Unclassified 409 error (not treated as capacity):',
      body
    );
    warnSpy.mockRestore();
  });

  // -- Other status codes and non-FlyApiError --

  it('returns false for other status codes', () => {
    expect(isFlyInsufficientResources(new FlyApiError('not found', 404, '{}'))).toBe(false);
    expect(isFlyInsufficientResources(new FlyApiError('server error', 500, '{}'))).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isFlyInsufficientResources(new Error('something'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFlyInsufficientResources('string')).toBe(false);
    expect(isFlyInsufficientResources(null)).toBe(false);
    expect(isFlyInsufficientResources(undefined)).toBe(false);
  });
});

describe('createMachine', () => {
  it('passes checks through to Fly createMachine request body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'machine-1',
          name: 'm',
          state: 'created',
          region: 'iad',
          instance_id: 'inst',
          config: {},
          created_at: '2026-02-21T00:00:00.000Z',
          updated_at: '2026-02-21T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await createMachine(
      fakeConfig,
      {
        image: 'registry.fly.io/test:latest',
        checks: {
          controller: {
            type: 'http',
            port: 18789,
            method: 'GET',
            path: '/health',
            interval: '30s',
            timeout: '5s',
          },
        },
      },
      { region: 'iad' }
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      config: { checks?: Record<string, unknown> };
    };
    expect(body.config.checks).toEqual({
      controller: {
        type: 'http',
        port: 18789,
        method: 'GET',
        path: '/health',
        interval: '30s',
        timeout: '5s',
      },
    });
    fetchSpy.mockRestore();
  });
});

// ============================================================================
// createVolumeWithFallback
// ============================================================================

const fakeConfig: FlyClientConfig = { apiToken: 'test', appName: 'test-app' };

function mockFetchResponse(status: number, body: object | string): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createVolumeWithFallback', () => {
  const baseRequest = { name: 'vol', size_gb: 10, compute: { cpus: 2, memory_mb: 4096 } };

  it('returns volume from first region on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(200, { id: 'vol-1', name: 'vol', region: 'dfw', state: 'created' })
      );

    const vol = await createVolumeWithFallback(fakeConfig, baseRequest, ['dfw', 'yyz']);

    expect(vol.id).toBe('vol-1');
    expect(vol.region).toBe('dfw');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('falls through to next region on capacity 412', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(412, { error: 'insufficient resources in region dfw' })
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, { id: 'vol-2', name: 'vol', region: 'yyz', state: 'created' })
      );

    const vol = await createVolumeWithFallback(fakeConfig, baseRequest, ['dfw', 'yyz']);

    expect(vol.id).toBe('vol-2');
    expect(vol.region).toBe('yyz');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('throws last error when all regions exhausted', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse(412, { error: 'insufficient resources in dfw' }))
      .mockResolvedValueOnce(mockFetchResponse(412, { error: 'insufficient resources in yyz' }));

    await expect(createVolumeWithFallback(fakeConfig, baseRequest, ['dfw', 'yyz'])).rejects.toThrow(
      'insufficient resources'
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('throws immediately on non-capacity errors (no fallthrough)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse(500, { error: 'internal error' }));

    await expect(createVolumeWithFallback(fakeConfig, baseRequest, ['dfw', 'yyz'])).rejects.toThrow(
      'internal error'
    );

    // Should NOT have tried yyz
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('throws when no regions provided', async () => {
    await expect(createVolumeWithFallback(fakeConfig, baseRequest, [])).rejects.toThrow(
      'no regions provided'
    );
  });

  it('passes compute hint and other fields to each attempt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse(412, { error: 'insufficient resources' }))
      .mockResolvedValueOnce(
        mockFetchResponse(200, { id: 'vol-1', name: 'vol', region: 'yyz', state: 'created' })
      );

    const request = { ...baseRequest, source_volume_id: 'vol-old' };
    await createVolumeWithFallback(fakeConfig, request, ['dfw', 'yyz']);

    // Both calls should have the full request body including compute and source_volume_id
    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(firstBody.region).toBe('dfw');
    expect(firstBody.compute).toEqual({ cpus: 2, memory_mb: 4096 });
    expect(firstBody.source_volume_id).toBe('vol-old');

    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
    expect(secondBody.region).toBe('yyz');
    expect(secondBody.compute).toEqual({ cpus: 2, memory_mb: 4096 });
    expect(secondBody.source_volume_id).toBe('vol-old');

    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ============================================================================
// listVolumeSnapshots
// ============================================================================

describe('listVolumeSnapshots', () => {
  it('returns snapshots array on success', async () => {
    const snapshots = [
      {
        id: 'snap-1',
        created_at: '2026-02-19T00:00:00Z',
        digest: 'sha256:abc',
        retention_days: 5,
        size: 1048576,
        status: 'complete',
        volume_size: 10737418240,
      },
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse(200, snapshots));

    const result = await listVolumeSnapshots(fakeConfig, 'vol-123');

    expect(result).toEqual(snapshots);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/volumes/vol-123/snapshots');
    fetchSpy.mockRestore();
  });

  it('returns empty array when no snapshots exist', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse(200, []));

    const result = await listVolumeSnapshots(fakeConfig, 'vol-456');

    expect(result).toEqual([]);
    fetchSpy.mockRestore();
  });

  it('throws on Fly API error', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse(404, { error: 'volume not found' }));

    await expect(listVolumeSnapshots(fakeConfig, 'vol-gone')).rejects.toThrow('volume not found');
    fetchSpy.mockRestore();
  });
});
