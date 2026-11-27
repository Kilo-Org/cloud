import { describe, expect, it } from 'vitest';
import { withoutSelfOriginCookies, withSelfAccessCredentials } from './access-credentials.js';

const env = {
  WORKER_URL: 'https://cloud-agent-e2e.example.test',
  E2E_ACCESS_CLIENT_ID: 'client-id.access',
  E2E_ACCESS_CLIENT_SECRET: 'client-secret',
};

describe('withSelfAccessCredentials', () => {
  it('stamps the service token on a request to the Worker origin', () => {
    const request = new Request('https://cloud-agent-e2e.example.test/sandbox-artifacts/v1/x', {
      headers: { authorization: 'Bearer grant', 'CF-Access-Client-Id': 'sandbox-supplied' },
    });
    const stamped = withSelfAccessCredentials(request, env);
    expect(stamped.headers.get('CF-Access-Client-Id')).toBe('client-id.access');
    expect(stamped.headers.get('CF-Access-Client-Secret')).toBe('client-secret');
    expect(stamped.headers.get('authorization')).toBe('Bearer grant');
    expect(stamped.url).toBe(request.url);
  });

  it('leaves every other origin unchanged', () => {
    for (const url of [
      'https://fake-llm.example.test/api/openrouter/chat/completions',
      'http://cloud-agent-e2e.example.test/sandbox-artifacts/v1/x',
      'https://cloud-agent-e2e.example.test.attacker.test/',
    ]) {
      const request = new Request(url);
      expect(withSelfAccessCredentials(request, env)).toBe(request);
    }
  });

  it('adds nothing without both credentials and a Worker URL', () => {
    const request = new Request('https://cloud-agent-e2e.example.test/');
    expect(withSelfAccessCredentials(request, { ...env, E2E_ACCESS_CLIENT_SECRET: '' })).toBe(
      request
    );
    expect(withSelfAccessCredentials(request, { ...env, E2E_ACCESS_CLIENT_ID: undefined })).toBe(
      request
    );
    expect(withSelfAccessCredentials(request, { ...env, WORKER_URL: undefined })).toBe(request);
  });
});

describe('withoutSelfOriginCookies', () => {
  const cookieResponse = () =>
    new Response('body', {
      status: 202,
      headers: { 'Set-Cookie': 'CF_Authorization=token; Secure', 'X-Kept': 'yes' },
    });

  it('drops Set-Cookie from a Worker-origin response and keeps the rest', async () => {
    const stripped = withoutSelfOriginCookies(
      new Request('https://cloud-agent-e2e.example.test/sandbox-control/x'),
      cookieResponse(),
      env
    );
    expect(stripped.headers.has('Set-Cookie')).toBe(false);
    expect(stripped.headers.get('X-Kept')).toBe('yes');
    expect(stripped.status).toBe(202);
    expect(await stripped.text()).toBe('body');
  });

  it('treats a wss URL of the Worker host as its own origin', () => {
    const request = new Request('https://cloud-agent-e2e.example.test/x');
    const stamped = withSelfAccessCredentials(request, {
      ...env,
      WORKER_URL: 'wss://cloud-agent-e2e.example.test',
    });
    expect(stamped.headers.get('CF-Access-Client-Id')).toBe('client-id.access');
  });

  it('leaves other origins and cookie-free responses unchanged', () => {
    const other = cookieResponse();
    expect(withoutSelfOriginCookies(new Request('https://github.com/x'), other, env)).toBe(other);
    const plain = new Response('ok');
    expect(
      withoutSelfOriginCookies(new Request('https://cloud-agent-e2e.example.test/'), plain, env)
    ).toBe(plain);
  });
});
