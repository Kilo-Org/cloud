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

function outbound(props: ContainersOutboundProps) {
  return new ContainersOutbound(
    { props } as ExecutionContext<ContainersOutboundProps>,
    {} as Cloudflare.Env
  );
}

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
