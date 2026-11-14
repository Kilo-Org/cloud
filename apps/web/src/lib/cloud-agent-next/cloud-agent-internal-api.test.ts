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
