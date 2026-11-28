import { describe, expect, it, vi } from 'vitest';
import {
  withAccessCredentials,
  withAccessFetch,
  withoutAccessOriginCookies,
} from './access-credentials.js';

const env = {
  WORKER_URL: 'https://cloud-agent-e2e.example.test',
  E2E_FAKE_LLM_URL: 'https://fake-llm-e2e.example.test',
  E2E_ACCESS_CLIENT_ID: 'client-id.access',
  E2E_ACCESS_CLIENT_SECRET: 'client-secret',
};
const OTHER_ORIGINS = [
  'https://api.kilo.ai/api/openrouter/models/validate',
  'http://cloud-agent-e2e.example.test/sandbox-artifacts/v1/x',
  'https://cloud-agent-e2e.example.test.attacker.test/',
  'https://fake-llm-e2e.example.test.attacker.test/api/openrouter/models',
  'https://evil-fake-llm-e2e.example.test/',
];

describe('withAccessCredentials', () => {
  it('stamps the service token on a request to the Worker origin', () => {
    const request = new Request('https://cloud-agent-e2e.example.test/sandbox-artifacts/v1/x', {
      headers: { authorization: 'Bearer grant', 'CF-Access-Client-Id': 'sandbox-supplied' },
    });
    const stamped = withAccessCredentials(request, env);
    expect(stamped.headers.get('CF-Access-Client-Id')).toBe('client-id.access');
    expect(stamped.headers.get('CF-Access-Client-Secret')).toBe('client-secret');
    expect(stamped.headers.get('authorization')).toBe('Bearer grant');
    expect(stamped.url).toBe(request.url);
    // The token never follows a redirect to another URL.
    expect(stamped.redirect).toBe('manual');
  });

  it('stamps the service token on a request to the fake-LLM origin', () => {
    const request = new Request(
      'https://fake-llm-e2e.example.test/api/openrouter/chat/completions',
      { method: 'POST', body: '{}' }
    );
    const stamped = withAccessCredentials(request, env);
    expect(stamped.headers.get('CF-Access-Client-Id')).toBe('client-id.access');
    expect(stamped.headers.get('CF-Access-Client-Secret')).toBe('client-secret');
    expect(stamped.redirect).toBe('manual');
  });

  it('leaves every other origin unchanged, lookalike hosts included', () => {
    for (const url of OTHER_ORIGINS) {
      const request = new Request(url);
      expect(withAccessCredentials(request, env), url).toBe(request);
    }
  });

  it('adds nothing without both credentials and both hostnames', () => {
    for (const url of [env.WORKER_URL, env.E2E_FAKE_LLM_URL]) {
      const request = new Request(`${url}/`);
      for (const partial of [
        { ...env, E2E_ACCESS_CLIENT_SECRET: '' },
        { ...env, E2E_ACCESS_CLIENT_ID: undefined },
        { ...env, WORKER_URL: undefined },
        { ...env, E2E_FAKE_LLM_URL: undefined },
      ]) {
        expect(withAccessCredentials(request, partial), url).toBe(request);
      }
    }
  });

  it('treats a wss URL of the Worker host as its own origin', () => {
    const request = new Request('https://cloud-agent-e2e.example.test/x');
    const stamped = withAccessCredentials(request, {
      ...env,
      WORKER_URL: 'wss://cloud-agent-e2e.example.test',
    });
    expect(stamped.headers.get('CF-Access-Client-Id')).toBe('client-id.access');
  });
});

describe('withAccessFetch', () => {
  const recorder = () => {
    const base = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok')
    );
    return base;
  };

  it('stamps a Worker request to the fake-LLM origin and forces manual redirects', async () => {
    const base = recorder();
    await withAccessFetch(base, () => env)(
      'https://fake-llm-e2e.example.test/api/openrouter/models/validate',
      { method: 'POST', headers: { authorization: 'Bearer session' }, body: '{}' }
    );
    const [sent] = base.mock.calls[0];
    expect(sent).toBeInstanceOf(Request);
    const request = sent as Request;
    expect(request.headers.get('CF-Access-Client-Id')).toBe('client-id.access');
    expect(request.headers.get('CF-Access-Client-Secret')).toBe('client-secret');
    expect(request.headers.get('authorization')).toBe('Bearer session');
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('manual');
    expect(await request.text()).toBe('{}');
  });

  it('stamps a Worker request to its own origin given as a URL', async () => {
    const base = recorder();
    await withAccessFetch(base, () => env)(new URL('https://cloud-agent-e2e.example.test/cb'));
    expect((base.mock.calls[0][0] as Request).headers.get('CF-Access-Client-Id')).toBe(
      'client-id.access'
    );
  });

  it('passes every other request through with its original arguments', async () => {
    for (const url of OTHER_ORIGINS) {
      const base = recorder();
      const init = { method: 'GET', redirect: 'follow' as const };
      await withAccessFetch(base, () => env)(url, init);
      expect(base.mock.calls[0], url).toEqual([url, init]);
    }
  });

  it('stamps nothing when either hostname is unset', async () => {
    for (const partial of [
      { ...env, E2E_FAKE_LLM_URL: undefined },
      { ...env, WORKER_URL: undefined },
    ]) {
      const base = recorder();
      const url = 'https://fake-llm-e2e.example.test/api/openrouter/models';
      await withAccessFetch(base, () => partial)(url);
      expect(base.mock.calls[0]).toEqual([url, undefined]);
    }
  });

  it('reads the environment per call', async () => {
    const base = recorder();
    let current: typeof env | Record<string, never> = {};
    const wrapped = withAccessFetch(base, () => current);
    await wrapped('https://fake-llm-e2e.example.test/x');
    current = env;
    await wrapped('https://fake-llm-e2e.example.test/x');
    expect(typeof base.mock.calls[0][0]).toBe('string');
    expect((base.mock.calls[1][0] as Request).headers.get('CF-Access-Client-Id')).toBe(
      'client-id.access'
    );
  });
});

describe('withoutAccessOriginCookies', () => {
  const cookieResponse = () =>
    new Response('body', {
      status: 202,
      headers: { 'Set-Cookie': 'CF_Authorization=token; Secure', 'X-Kept': 'yes' },
    });

  it('drops Set-Cookie from a response of either e2e origin and keeps the rest', async () => {
    for (const url of [
      'https://cloud-agent-e2e.example.test/sandbox-control/x',
      'https://fake-llm-e2e.example.test/api/openrouter/chat/completions',
    ]) {
      const stripped = withoutAccessOriginCookies(new Request(url), cookieResponse(), env);
      expect(stripped.headers.has('Set-Cookie'), url).toBe(false);
      expect(stripped.headers.get('X-Kept')).toBe('yes');
      expect(stripped.status).toBe(202);
      expect(await stripped.text()).toBe('body');
    }
  });

  it('leaves other origins and cookie-free responses unchanged', () => {
    const other = cookieResponse();
    expect(withoutAccessOriginCookies(new Request('https://github.com/x'), other, env)).toBe(other);
    const plain = new Response('ok');
    expect(
      withoutAccessOriginCookies(new Request('https://cloud-agent-e2e.example.test/'), plain, env)
    ).toBe(plain);
  });
});
