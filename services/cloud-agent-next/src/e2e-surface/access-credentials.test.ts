import { describe, expect, it } from 'vitest';
import { withSelfAccessCredentials } from './access-credentials.js';

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
