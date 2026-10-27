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
import type { getSentryConfig } from '../shared/sentry.js';

function outbound(
  props: ContainersOutboundProps,
  sentry: Parameters<typeof getSentryConfig>[0] = {}
) {
  return new ContainersOutbound(
    { props } as ExecutionContext<ContainersOutboundProps>,
    sentry as Cloudflare.Env & Parameters<typeof getSentryConfig>[0]
  );
}

const sentry = {
  CLOUD_AGENT_SENTRY_DSN: 'https://0123456789abcdef@o123.ingest.sentry.io/456',
  CLOUD_AGENT_SENTRY_ENVIRONMENT: 'production',
};

afterEach(() => vi.clearAllMocks());

describe('ContainersOutbound egress enforcement', () => {
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

  it('allows only the trusted Sentry envelope endpoint without extending the pinned allowlist', async () => {
    const egressAllowlist: string[] = [];
    const request = new Request(
      'https://o123.ingest.sentry.io/api/456/envelope/?sentry_version=7&sentry_key=0123456789abcdef',
      { method: 'POST', headers: { Host: 'evil.test' }, body: 'envelope' }
    );

    const response = await outbound({ containerId: 'container-1', egressAllowlist }, sentry).fetch(
      request
    );

    expect(response.status).toBe(200);
    expect(egressAllowlist).toEqual([]);
    const forwarded = vi.mocked(handleManagedScmOutbound).mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(request.url);
    expect(forwarded?.redirect).toBe('manual');
    expect(forwarded?.headers.get('Host')).toBe('o123.ingest.sentry.io');
    expect(await forwarded?.text()).toBe('envelope');
  });

  it.each([
    ['GET', 'https://o123.ingest.sentry.io/api/456/envelope/'],
    ['PUT', 'https://o123.ingest.sentry.io/api/456/envelope/'],
    ['POST', 'http://o123.ingest.sentry.io/api/456/envelope/'],
    ['POST', 'https://o123.ingest.sentry.io:8443/api/456/envelope/'],
    ['POST', 'https://o124.ingest.sentry.io/api/456/envelope/'],
    ['POST', 'https://sub.o123.ingest.sentry.io/api/456/envelope/'],
    ['POST', 'https://evil.test/api/456/envelope/'],
    ['POST', 'https://o123.ingest.sentry.io/api/123/envelope/'],
    ['POST', 'https://o123.ingest.sentry.io/api/456/store/'],
    ['POST', 'https://o123.ingest.sentry.io/api/456/envelope'],
    ['POST', 'https://o123.ingest.sentry.io/api/456/envelope/extra'],
    ['POST', 'https://o123.ingest.sentry.io/'],
  ])('does not broaden egress with telemetry enabled: %s %s', async (method, url) => {
    const response = await outbound(
      { containerId: 'container-1', egressAllowlist: [] },
      sentry
    ).fetch(new Request(url, { method, headers: { Host: 'o123.ingest.sentry.io' } }));

    expect(response.status).toBe(403);
    expect(handleManagedScmOutbound).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { CLOUD_AGENT_SENTRY_DSN: 'http://key@o123.ingest.sentry.io/456' },
    { CLOUD_AGENT_SENTRY_DSN: 'invalid' },
    { CLOUD_AGENT_SENTRY_DSN: 'https://key@o123.ingest.sentry.io/not-a-project' },
  ])('fails closed without valid trusted telemetry configuration: %j', async configuration => {
    const response = await outbound(
      { containerId: 'container-1', egressAllowlist: [] },
      configuration
    ).fetch(
      new Request('https://o123.ingest.sentry.io/api/456/envelope/', {
        method: 'POST',
        headers: { CLOUD_AGENT_SENTRY_DSN: sentry.CLOUD_AGENT_SENTRY_DSN },
      })
    );

    expect(response.status).toBe(403);
    expect(handleManagedScmOutbound).not.toHaveBeenCalled();
  });

  it('does not follow a redirect from the trusted telemetry endpoint', async () => {
    vi.mocked(handleManagedScmOutbound).mockImplementationOnce(async request => {
      expect(request.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } });
    });

    const response = await outbound(
      { containerId: 'container-1', egressAllowlist: [] },
      sentry
    ).fetch(new Request('https://o123.ingest.sentry.io/api/456/envelope/', { method: 'POST' }));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://evil.test/');
    expect(handleManagedScmOutbound).toHaveBeenCalledOnce();
  });

  it('does not let telemetry bypass invalid pinned policy props', async () => {
    const response = await outbound(
      { containerId: 'container-1', egressAllowlist: ['*'] },
      sentry
    ).fetch(new Request('https://o123.ingest.sentry.io/api/456/envelope/', { method: 'POST' }));

    expect(response.status).toBe(502);
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
