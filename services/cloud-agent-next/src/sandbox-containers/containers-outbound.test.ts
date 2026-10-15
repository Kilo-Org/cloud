import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown
    ) {}
  },
}));
vi.mock('../sandbox-outbound.js', () => ({
  handleManagedScmOutbound: vi.fn(async () => new Response('forwarded')),
}));

import { handleManagedScmOutbound } from '../sandbox-outbound.js';
import { ContainersOutbound, type ContainersOutboundProps } from './containers-outbound.js';

function outbound(props: ContainersOutboundProps, env: Partial<Cloudflare.Env> = {}) {
  return new ContainersOutbound(
    { props } as ExecutionContext<ContainersOutboundProps>,
    env as Cloudflare.Env
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function auditFixture() {
  const recordEgressRequest = vi.fn(async (_input: unknown) => undefined);
  const get = vi.fn(() => ({ recordEgressRequest }));
  const idFromString = vi.fn((id: string) => id);
  const env = { SANDBOX_CONTAINERS: { get, idFromString } } as unknown as Cloudflare.Env;
  const props = {
    containerId: 'container-1',
    allocationRef: 'allocation-1',
    egressAllowlist: ['example.com'],
    egressAudit: true,
  };
  return { worker: outbound(props, env), props, env, recordEgressRequest, get, idFromString };
}

describe('ContainersOutbound egress enforcement', () => {
  it.each([undefined, false])(
    'does not write audit records when opted out: %s',
    async egressAudit => {
      const { env, recordEgressRequest, get } = auditFixture();
      await outbound(
        { containerId: 'container-1', egressAllowlist: ['example.com'], egressAudit },
        env
      ).fetch(new Request('https://example.com/'));
      await outbound({ containerId: 'container-1', egressAllowlist: [], egressAudit }, env).fetch(
        new Request('https://example.com/')
      );
      expect(recordEgressRequest).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['https://example.com/private?token=secret', 'allowed', 200, 443],
    ['http://evil.test/private?token=secret', 'denied', 403, 80],
    ['https://example.com:8443/private?token=secret', 'denied', 403, 8443],
  ])(
    'records %s before forwarding or returning a policy block',
    async (url, decision, status, port) => {
      const { worker, recordEgressRequest, get, idFromString } = auditFixture();
      recordEgressRequest.mockImplementationOnce(async () => {
        expect(handleManagedScmOutbound).not.toHaveBeenCalled();
      });
      const response = await worker.fetch(
        new Request(url, {
          method: 'POST',
          headers: { Authorization: 'Bearer secret', 'x-api-key': 'secret' },
          body: 'secret-body',
        })
      );
      expect(response.status).toBe(status);
      expect(idFromString).toHaveBeenCalledWith('container-1');
      expect(get).toHaveBeenCalledTimes(1);
      expect(recordEgressRequest).toHaveBeenCalledWith({
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        allocationRef: 'allocation-1',
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        method: 'POST',
        hostname: new URL(url).hostname,
        protocol: new URL(url).protocol,
        port,
        decision,
      });
      expect(JSON.stringify(recordEgressRequest.mock.calls)).not.toContain('secret');
      expect(handleManagedScmOutbound).toHaveBeenCalledTimes(decision === 'allowed' ? 1 : 0);
    }
  );

  it('redacts URL userinfo as well as paths and queries from denied records', async () => {
    const { worker, recordEgressRequest } = auditFixture();
    const response = await worker.fetch({
      url: 'https://user:secret@example.com/private?token=secret',
      method: 'GET',
    } as Request);
    expect(response.status).toBe(403);
    expect(recordEgressRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'example.com',
        decision: 'denied',
      })
    );
    expect(JSON.stringify(recordEgressRequest.mock.calls)).not.toMatch(/secret|user|private|token/);
  });

  it.each([
    'https://outside.test/private?token=secret',
    'http://127.0.0.1/',
    'https://example.com:8443/',
  ])('audits unrestricted requests without imposing an allowlist: %s', async url => {
    const { props, env, recordEgressRequest } = auditFixture();
    const request = new Request(url);
    recordEgressRequest.mockImplementationOnce(async () => {
      expect(handleManagedScmOutbound).not.toHaveBeenCalled();
    });
    const response = await outbound({ ...props, egressAllowlist: undefined }, env).fetch(request);
    expect(response.status).toBe(200);
    expect(recordEgressRequest).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: new URL(url).hostname, decision: 'allowed' })
    );
    expect(JSON.stringify(recordEgressRequest.mock.calls)).not.toMatch(/secret|private|token/);
    expect(handleManagedScmOutbound).toHaveBeenCalledWith(request, env, {
      containerId: 'container-1',
    });
  });

  it('keeps the same request identity and obtains a fresh physical DO stub on retry', async () => {
    const { worker, recordEgressRequest, get } = auditFixture();
    recordEgressRequest.mockRejectedValueOnce(
      Object.assign(new Error('temporary secret'), { retryable: true })
    );
    const response = await worker.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(2);
    expect(recordEgressRequest.mock.calls[0]?.[0]).toEqual(recordEgressRequest.mock.calls[1]?.[0]);
    expect(handleManagedScmOutbound).toHaveBeenCalledTimes(1);
  });

  it.each([
    { url: 'https://example.com/', egressAllowlist: ['example.com'] },
    { url: 'https://evil.test/', egressAllowlist: ['example.com'] },
    { url: 'https://outside.test/', egressAllowlist: undefined },
  ])('fails closed after bounded retry exhaustion for %s', async ({ url, egressAllowlist }) => {
    const { props, env, recordEgressRequest } = auditFixture();
    recordEgressRequest.mockRejectedValue(Object.assign(new Error('secret'), { retryable: true }));
    const response = await outbound({ ...props, egressAllowlist }, env).fetch(new Request(url));
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Egress audit unavailable');
    expect(recordEgressRequest).toHaveBeenCalledTimes(3);
    expect(handleManagedScmOutbound).not.toHaveBeenCalled();
  });

  it('bounds stalled persistence and never forwards while storage is pending', async () => {
    vi.useFakeTimers();
    const { worker, recordEgressRequest } = auditFixture();
    recordEgressRequest.mockImplementationOnce(() => new Promise(() => {}));
    const pending = worker.fetch(new Request('https://example.com/'));
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Egress audit unavailable');
    expect(handleManagedScmOutbound).not.toHaveBeenCalled();
  });

  it.each([{ allocationRef: undefined }, { allocationRef: '' }, { egressAudit: 'true' }])(
    'rejects incomplete or invalid trusted audit props: %j',
    async invalid => {
      const { props, env, recordEgressRequest } = auditFixture();
      const response = await outbound(
        { ...props, ...invalid } as ContainersOutboundProps,
        env
      ).fetch(new Request('https://example.com/'));
      expect(response.status).toBe(502);
      expect(handleManagedScmOutbound).not.toHaveBeenCalled();
      expect(recordEgressRequest).not.toHaveBeenCalled();
    }
  );

  it('does not enable auditing from sandbox-controlled headers', async () => {
    const { env, recordEgressRequest } = auditFixture();
    await outbound({ containerId: 'container-1', egressAllowlist: ['example.com'] }, env).fetch(
      new Request('https://example.com/', {
        headers: { 'x-egress-audit': 'true', 'x-allocation-ref': 'allocation-1' },
      })
    );
    expect(recordEgressRequest).not.toHaveBeenCalled();
  });

  it.each([undefined, ['example.com']])(
    'preserves streamed bodies and redirects while auditing with allowlist %j',
    async egressAllowlist => {
      const { props, env } = auditFixture();
      const worker = outbound({ ...props, egressAllowlist }, env);
      const responseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('response-stream'));
          controller.close();
        },
      });
      const forwardedResponse = new Response(responseBody, {
        status: 302,
        headers: { Location: 'https://evil.test/' },
      });
      vi.mocked(handleManagedScmOutbound).mockResolvedValueOnce(forwardedResponse);
      const request = new Request('https://example.com/upload', {
        method: 'POST',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('request-stream'));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
      const response = await worker.fetch(request);
      const forwarded = vi.mocked(handleManagedScmOutbound).mock.calls[0]?.[0];
      expect(forwarded?.redirect).toBe(egressAllowlist === undefined ? request.redirect : 'manual');
      expect(forwarded?.bodyUsed).toBe(false);
      expect(response).toBe(forwardedResponse);
      expect(response.bodyUsed).toBe(false);
      expect(await forwarded?.text()).toBe('request-stream');
      expect(await response.text()).toBe('response-stream');
    }
  );

  it('leaves unrestricted requests and credential handling unchanged', async () => {
    const request = new Request('https://example.com:8443/');
    await outbound({ containerId: 'container-1' }).fetch(request);
    expect(handleManagedScmOutbound).toHaveBeenCalledWith(
      request,
      {},
      { containerId: 'container-1' }
    );
  });

  it('sets manual redirects before forwarding allowed requests to the credential broker', async () => {
    const request = new Request('https://example.com/upload', {
      method: 'POST',
      headers: { Host: 'evil.test', Authorization: 'Bearer kka1.opaque' },
      body: 'body',
    });
    const response = await outbound({
      containerId: 'container-1',
      egressAllowlist: ['example.com'],
    }).fetch(request);
    expect(response.status).toBe(200);
    const forwarded = vi.mocked(handleManagedScmOutbound).mock.calls[0]?.[0];
    expect(forwarded?.redirect).toBe('manual');
    expect(forwarded?.headers.get('Host')).toBe('example.com');
    expect(forwarded?.headers.get('Authorization')).toBe('Bearer kka1.opaque');
    expect(await forwarded?.text()).toBe('body');
  });

  it.each([
    'https://evil.test/',
    'https://sub.example.com/',
    'https://example.com:8443/',
    'http://127.0.0.1/',
  ])('rejects disallowed destinations before credential redemption: %s', async url => {
    const response = await outbound({
      containerId: 'container-1',
      egressAllowlist: ['example.com'],
    }).fetch(
      new Request(url, { headers: { Host: 'example.com', Authorization: 'Bearer kka1.opaque' } })
    );
    expect(response.status).toBe(403);
    expect(handleManagedScmOutbound).not.toHaveBeenCalled();
  });

  it('does not trust request headers or sandbox environment to extend an empty policy', async () => {
    const worker = new ContainersOutbound(
      {
        props: { containerId: 'container-1', egressAllowlist: [] },
      } as unknown as ExecutionContext<ContainersOutboundProps>,
      { EGRESS_ALLOWLIST: 'example.com' } as unknown as Cloudflare.Env
    );
    const response = await worker.fetch(
      new Request('https://example.com/', {
        headers: { 'x-egress-allowlist': 'example.com' },
      })
    );
    expect(response.status).toBe(403);
    expect(handleManagedScmOutbound).not.toHaveBeenCalled();
  });

  it.each(
    [null, ['*'], ['127.0.0.1'], 'example.com'].map(egressAllowlist => ({ egressAllowlist }))
  )('fails closed for invalid runtime props: %j', async ({ egressAllowlist }) => {
    const response = await outbound({
      containerId: 'container-1',
      egressAllowlist,
    } as ContainersOutboundProps).fetch(new Request('https://example.com/'));
    expect(response.status).toBe(502);
    expect(handleManagedScmOutbound).not.toHaveBeenCalled();
  });

  it('fails closed without a runtime-bound container id', async () => {
    const response = await outbound({ containerId: '', egressAllowlist: ['example.com'] }).fetch(
      new Request('https://example.com/')
    );
    expect(response.status).toBe(502);
    expect(handleManagedScmOutbound).not.toHaveBeenCalled();
  });
});
