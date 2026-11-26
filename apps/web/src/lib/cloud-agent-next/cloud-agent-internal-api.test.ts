import { afterEach, describe, expect, it } from '@jest/globals';

// These mocks must use the global `jest` (not the one imported from
// `@jest/globals`): the transform hoists `jest.mock` above the imports only
// when it resolves to the global, and the module under test reads both values
// at load time.
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({
  getEnvVariable: () => 'http://cloud-agent-next',
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-secret',
}));

// The jest setup file loads these shared modules before this test file runs, and
// a later `jest.mock` does not replace an already-loaded instance. Drop the
// registry so the module under test reads the mocked values.
jest.resetModules();

import { installInternalApiSecretRead } from '@kilocode/web-shared/lib/internal-api-secret';
import { ServiceFetchTimeoutError } from '../bounded-service-fetch';
import {
  cleanupVercelSnapshotBuild,
  closeCloudAgentOrgStreams,
  getVercelComputeEnrollment,
  getVercelComputeEnrollmentForUser,
  getVercelRuntimeIdentity,
  readCloudAgentWidgetApprovalKey,
} from './cloud-agent-internal-api';

describe('closeCloudAgentOrgStreams', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs to the close endpoint with the internal key header and body', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await closeCloudAgentOrgStreams('usr_1', 'org_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://cloud-agent-next/internal/streams/close',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-secret',
        },
        body: JSON.stringify({ userId: 'usr_1', organizationId: 'org_1' }),
      })
    );
  });

  it('throws when the close endpoint returns a non-OK response', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(
        new Response('boom', { status: 500, statusText: 'Internal Server Error' })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(closeCloudAgentOrgStreams('usr_1', 'org_1')).rejects.toThrow(
      'Cloud Agent stream close failed: 500 Internal Server Error - boom'
    );
  });
});

describe('readCloudAgentWidgetApprovalKey', () => {
  const originalFetch = global.fetch;
  const input = {
    userId: 'usr_1',
    organizationId: null,
    kiloSessionId: 'ses_0123456789abcdefghijklmnop',
    cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
  };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  function respond(response: Response) {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(response);
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('POSTs the exact owned scope with the internal key and returns the binding and command', async () => {
    const key = 'b'.repeat(64);
    const fetchMock = respond(
      new Response(JSON.stringify({ approvalKey: key, command: 'pnpm test' }))
    );

    await expect(readCloudAgentWidgetApprovalKey(input)).resolves.toEqual({
      approvalKey: key,
      command: 'pnpm test',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://cloud-agent-next/internal/widgets/approval-key',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-api-key': 'test-secret' },
        body: JSON.stringify(input),
      })
    );
  });

  it('reads a newer Worker answer without a command as no command', async () => {
    const key = 'b'.repeat(64);
    respond(new Response(JSON.stringify({ approvalKey: key })));

    await expect(readCloudAgentWidgetApprovalKey(input)).resolves.toEqual({
      approvalKey: key,
      command: null,
    });
  });

  it('rejects a response that is not a lowercase SHA-256 binding', async () => {
    respond(new Response(JSON.stringify({ approvalKey: 'per_raw_permission' })));
    await expect(readCloudAgentWidgetApprovalKey(input)).rejects.toThrow();
  });

  it('throws on a refused read without echoing the body', async () => {
    respond(new Response('Session access denied ses_private', { status: 403 }));
    await expect(readCloudAgentWidgetApprovalKey(input)).rejects.toThrow(
      /^Cloud Agent widget approval key failed: 403$/
    );
  });

  it('bounds a body the Worker stalls after its headers inside the widget budget', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn(async () => undefined);
    let bursts = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        bursts += 1;
        if (bursts === 1) {
          controller.enqueue(encoder.encode('{"approvalKey":'));
        }
      },
      cancel,
    });
    respond(new Response(stream, { status: 200 }));

    const outcome = readCloudAgentWidgetApprovalKey(input).catch((error: unknown) => error);

    let settledEarly = false;
    void outcome.then(() => {
      settledEarly = true;
    });

    await jest.advanceTimersByTimeAsync(1_499);
    expect(settledEarly).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(ServiceFetchTimeoutError);
    expect((error as ServiceFetchTimeoutError).totalBudgetMs).toBe(1_500);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels the unread body of a refused answer', async () => {
    const cancel = jest.fn(async () => undefined);
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // A denied answer's body is never read, so nothing is enqueued.
      },
      cancel,
    });
    respond(new Response(stream, { status: 403 }));

    await expect(readCloudAgentWidgetApprovalKey(input)).rejects.toThrow(
      /^Cloud Agent widget approval key failed: 403$/
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('lets the caller signal win over a stalled body read', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn(async () => undefined);
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Headers arrived, the body never completes.
      },
      cancel,
    });
    respond(new Response(stream, { status: 200 }));

    const caller = new AbortController();
    const callerReason = new Error('request went away');
    const outcome = readCloudAgentWidgetApprovalKey(input, caller.signal).catch(
      (error: unknown) => error
    );

    await jest.advanceTimersByTimeAsync(100);
    caller.abort(callerReason);

    const error = await outcome;
    expect(error).toBe(callerReason);
    expect(error).not.toBeInstanceOf(ServiceFetchTimeoutError);
    expect(jest.getTimerCount()).toBe(0);
  });

  describe('with the web app read installed', () => {
    afterEach(() => {
      globalThis.__kilocodeInternalApiSecretRead = undefined;
    });

    it('sends the installed secret under the same deadline', async () => {
      const fetchMock = respond(new Response(JSON.stringify({ approvalKey: 'b'.repeat(64) })));
      installInternalApiSecretRead(async () => 'sts-delivered-secret');

      await readCloudAgentWidgetApprovalKey(input);

      expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
        'content-type': 'application/json',
        'x-internal-api-key': 'sts-delivered-secret',
      });
    });

    it('lets the caller abort end a pending secret read and never sends afterwards', async () => {
      const fetchMock = respond(new Response(JSON.stringify({ approvalKey: 'b'.repeat(64) })));
      const secret = Promise.withResolvers<string>();
      installInternalApiSecretRead(() => secret.promise);
      const caller = new AbortController();
      const callerReason = new Error('request went away');

      const outcome = readCloudAgentWidgetApprovalKey(input, caller.signal).catch(
        (error: unknown) => error
      );
      caller.abort(callerReason);

      expect(await outcome).toBe(callerReason);
      secret.resolve('late-secret');
      await new Promise(resolve => setImmediate(resolve));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ends a secret read that outlasts the widget budget without a request', async () => {
      const fetchMock = respond(new Response(JSON.stringify({ approvalKey: 'b'.repeat(64) })));
      installInternalApiSecretRead(() => new Promise<string>(() => undefined));

      const error = await readCloudAgentWidgetApprovalKey(input).catch((cause: unknown) => cause);

      expect((error as Error).name).toBe('TimeoutError');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('getVercelComputeEnrollment', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([true, false])('returns the authenticated Worker enrollment value %s', async enrolled => {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(Response.json({ enrolled }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getVercelComputeEnrollment('org/with-path')).resolves.toBe(enrolled);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://cloud-agent-next/internal/byoc/vercel-enrollment/org%2Fwith-path',
      expect.objectContaining({
        headers: { 'x-internal-api-key': 'test-secret' },
        cache: 'no-store',
      })
    );
  });

  it('fails closed when the Worker response is malformed', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(Response.json({ enrolled: 'true' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getVercelComputeEnrollment('org_1')).rejects.toThrow(
      'Cloud Agent Vercel compute enrollment could not be verified'
    );
  });

  it('does not expose upstream response details when enrollment cannot be verified', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(new Response('sensitive upstream details', { status: 502 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getVercelComputeEnrollment('org_1')).rejects.toThrow(
      'Cloud Agent Vercel compute enrollment could not be verified'
    );
  });

  it('encodes OAuth user ids on the personal enrollment endpoint', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(Response.json({ enrolled: true }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getVercelComputeEnrollmentForUser('oauth/provider/user id')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://cloud-agent-next/internal/byoc/vercel-enrollment/user/oauth%2Fprovider%2Fuser%20id',
      expect.objectContaining({
        headers: { 'x-internal-api-key': 'test-secret' },
        cache: 'no-store',
      })
    );
  });
});

describe('getVercelRuntimeIdentity', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the Worker runtime identity', async () => {
    const identity = {
      wrapperVersion: '2.4.0',
      releasedAt: '2026-09-08',
      digest: 'digest-1',
    };
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(Response.json(identity));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getVercelRuntimeIdentity()).resolves.toEqual(identity);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://cloud-agent-next/internal/byoc/vercel-runtime-identity',
      expect.objectContaining({
        headers: { 'x-internal-api-key': 'test-secret' },
        cache: 'no-store',
      })
    );
  });
});

describe('cleanupVercelSnapshotBuild', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends the persisted snapshot identifier to the authenticated cleanup endpoint', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const input = {
      organizationId: 'org_1',
      credentialId: 'credential_1',
      buildGeneration: 'generation_1',
      snapshotId: 'snap_existing',
    };

    await cleanupVercelSnapshotBuild(input);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://cloud-agent-next/internal/byoc/vercel-snapshot-build/cleanup',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-secret',
        },
        body: JSON.stringify(input),
      })
    );
  });

  it('fails safely when cleanup is rejected', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(new Response('sensitive provider details', { status: 502 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      cleanupVercelSnapshotBuild({
        organizationId: 'org_1',
        credentialId: 'credential_1',
        buildGeneration: 'generation_1',
      })
    ).rejects.toThrow('Cloud Agent Vercel compute cleanup could not be completed');
  });
});
