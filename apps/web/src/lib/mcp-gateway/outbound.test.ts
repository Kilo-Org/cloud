jest.mock('node:dns/promises', () => ({ resolve4: jest.fn(), resolve6: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));

import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { gzipSync } from 'node:zlib';
import {
  connectedAddress,
  recordHttpsRequests,
  type RecordedRequest,
} from '@/tests/helpers/outbound-https-mock';
import { requestPublicHttps, resolvePublicDestination } from './outbound';

describe('requestPublicHttps', () => {
  beforeEach(() => {
    jest.mocked(resolve4).mockReset();
    jest.mocked(resolve6).mockReset();
    jest.mocked(httpsRequest).mockReset();
    jest.mocked(resolve6).mockResolvedValue([]);
  });

  it('sends the request to the address resolved at request start', async () => {
    jest
      .mocked(resolve4)
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValue(['169.254.169.254']);
    const recorded = recordHttpsRequests(() => ({ body: '{}' }));

    const response = await requestPublicHttps('https://service.example/resource');

    expect(response.status).toBe(200);
    expect(jest.mocked(resolve4)).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
    expect(connectedAddress(recorded[0] as RecordedRequest)).toBe('93.184.216.34');
    expect(jest.mocked(resolve4)).toHaveBeenCalledTimes(1);
  });

  it('requires every resolved address to be public', async () => {
    jest.mocked(resolve4).mockResolvedValue(['93.184.216.34', '169.254.169.254']);

    await expect(resolvePublicDestination('https://service.example')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(jest.mocked(httpsRequest)).not.toHaveBeenCalled();
  });

  it('preserves host, port, method, path, and body', async () => {
    jest.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    const recorded = recordHttpsRequests(() => ({ body: '{"ok":true}' }));

    await requestPublicHttps('https://provider.example:8443/token?a=1', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: JSON.stringify({ code: 'abc' }),
      redirect: 'manual',
    });

    const request = recorded[0] as RecordedRequest;
    expect(request.options.hostname).toBe('provider.example');
    expect(request.options.port).toBe(8443);
    expect(request.options.path).toBe('/token?a=1');
    expect(request.options.method).toBe('POST');
    expect(request.options.headers.host).toBe('provider.example:8443');
    expect(request.options.headers.accept).toBe('application/json');
    expect(request.options.servername).toBe('provider.example');
    expect(connectedAddress(request)).toBe('93.184.216.34');
    expect(request.body?.toString()).toBe('{"code":"abc"}');
  });

  it('sends form bodies and defaults the port to 443', async () => {
    jest.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    const recorded = recordHttpsRequests(() => ({ body: '{}' }));

    await requestPublicHttps('https://provider.example/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', client_secret: 's3cret' }),
    });

    const request = recorded[0] as RecordedRequest;
    expect(request.options.port).toBe(443);
    expect(request.options.headers.host).toBe('provider.example');
    expect(request.body?.toString()).toBe('grant_type=authorization_code&client_secret=s3cret');
  });

  it('connects to public IP literals without a DNS lookup', async () => {
    const recorded = recordHttpsRequests(() => ({ body: '{}' }));

    await requestPublicHttps('https://[2606:4700:4700::1111]/resource');

    expect(jest.mocked(resolve4)).not.toHaveBeenCalled();
    const request = recorded[0] as RecordedRequest;
    expect(request.options.hostname).toBe('2606:4700:4700::1111');
    expect(request.options.headers.host).toBe('[2606:4700:4700::1111]');
    expect(request.options.servername).toBeUndefined();
    expect(connectedAddress(request)).toBe('2606:4700:4700::1111');
  });

  it('decodes compressed responses and reports the decoded body', async () => {
    jest.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    const payload = Buffer.from(JSON.stringify({ resource: 'https://service.example/mcp' }));
    recordHttpsRequests(() => ({
      headers: { 'content-encoding': 'gzip', 'content-length': String(payload.byteLength) },
      body: gzipSync(payload),
    }));

    const response = await requestPublicHttps('https://service.example/metadata');

    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    await expect(response.json()).resolves.toEqual({ resource: 'https://service.example/mcp' });
  });

  it('bounds the request and honors an abort signal', async () => {
    jest.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    const recorded = recordHttpsRequests(() => ({ body: '{}' }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestPublicHttps('https://service.example/metadata', { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'temporarily_unavailable' });

    const request = recorded[0] as RecordedRequest;
    expect(request.request.setTimeout).toHaveBeenCalledWith(30_000, expect.any(Function));
    expect(request.request.destroy).toHaveBeenCalled();
  });

  it('aborts a request that is waiting for the response', async () => {
    jest.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    const recorded = recordHttpsRequests(() => ({ body: '{}', defer: true }));
    const controller = new AbortController();
    const pending = requestPublicHttps('https://service.example/metadata', {
      signal: controller.signal,
    });

    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    setImmediate(markStarted);
    await started;
    expect(recorded).toHaveLength(1);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect((recorded[0] as RecordedRequest).request.destroy).toHaveBeenCalled();
  });
});
