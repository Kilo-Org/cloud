import { describe, expect, it } from 'vitest';
import { workerAccessHeaders } from '../../e2e/worker-access.js';

const env = {
  WORKER_URL: 'https://cloud-agent-e2e.example.test',
  E2E_ACCESS_CLIENT_ID: 'client-id.access',
  E2E_ACCESS_CLIENT_SECRET: 'client-secret',
};
const headers = {
  'CF-Access-Client-Id': 'client-id.access',
  'CF-Access-Client-Secret': 'client-secret',
};

describe('workerAccessHeaders', () => {
  it('sends the token to the WORKER_URL origin over http and ws', () => {
    for (const url of [
      'https://cloud-agent-e2e.example.test/trpc/getSession',
      'wss://cloud-agent-e2e.example.test/stream?ticket=t',
      'https://cloud-agent-e2e.example.test/__e2e/callbacks/token',
    ]) {
      expect(workerAccessHeaders(url, env), url).toEqual(headers);
    }
  });

  it('never sends the token to another origin', () => {
    for (const url of [
      'https://api.kilo.ai/api/cloud-agent-next/token',
      'https://fake-llm.example.test/test/requests',
      'https://cloud-agent-e2e.example.test.attacker.test/',
      'http://cloud-agent-e2e.example.test/',
    ]) {
      expect(workerAccessHeaders(url, env), url).toEqual({});
    }
    expect(workerAccessHeaders(env.WORKER_URL, { ...env, WORKER_URL: undefined })).toEqual({});
  });

  it('adds nothing without a token and refuses half a token', () => {
    expect(workerAccessHeaders(env.WORKER_URL, { WORKER_URL: env.WORKER_URL })).toEqual({});
    expect(() =>
      workerAccessHeaders(env.WORKER_URL, { ...env, E2E_ACCESS_CLIENT_SECRET: '' })
    ).toThrow(/both/);
  });
});
