/* eslint-disable vitest/prefer-describe-function-title -- conflicts with jest/valid-title which requires string titles */
import { describe, expect, it, vi } from 'vitest';
import { getCloudAgentWsUrl, getSessionIngestWsUrl } from './cloud-agent-config';

const withStubbedEnv = (env: Record<string, string>): void => {
  vi.unstubAllEnvs();

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
};

describe('getCloudAgentWsUrl', () => {
  it('respects VITE_CLOUD_AGENT_WS_URL override during build', () => {
    withStubbedEnv({
      COMMAND: 'build',
      VITE_CLOUD_AGENT_WS_URL: 'wss://custom.example.com',
    });
    expect(getCloudAgentWsUrl()).toBe('wss://custom.example.com');
  });

  it('trims trailing slash from override', () => {
    withStubbedEnv({
      COMMAND: 'build',
      VITE_CLOUD_AGENT_WS_URL: 'wss://custom.example.com/',
    });
    expect(getCloudAgentWsUrl()).toBe('wss://custom.example.com');
  });

  it('ignores whitespace-only override', () => {
    withStubbedEnv({
      COMMAND: 'build',
      VITE_CLOUD_AGENT_WS_URL: '   ',
    });
    expect(getCloudAgentWsUrl()).toBe('wss://cloud-agent-next.kilosessions.ai');
  });

  it('returns production fallback during build when no override', () => {
    withStubbedEnv({ COMMAND: 'build' });
    expect(getCloudAgentWsUrl()).toBe('wss://cloud-agent-next.kilosessions.ai');
  });

  it('returns local serve fallback during serve when no override', () => {
    withStubbedEnv({ COMMAND: 'serve' });
    expect(getCloudAgentWsUrl()).toBe('ws://localhost:8794');
  });

  it('override takes precedence over serve fallback', () => {
    withStubbedEnv({
      COMMAND: 'serve',
      VITE_CLOUD_AGENT_WS_URL: 'wss://staging.example.com',
    });
    expect(getCloudAgentWsUrl()).toBe('wss://staging.example.com');
  });
});

describe('getSessionIngestWsUrl', () => {
  it('respects VITE_SESSION_INGEST_WS_URL override during build', () => {
    withStubbedEnv({
      COMMAND: 'build',
      VITE_SESSION_INGEST_WS_URL: 'wss://ingest.example.com',
    });
    expect(getSessionIngestWsUrl()).toBe('wss://ingest.example.com');
  });

  it('trims trailing slash from override', () => {
    withStubbedEnv({
      COMMAND: 'build',
      VITE_SESSION_INGEST_WS_URL: 'wss://ingest.example.com/',
    });
    expect(getSessionIngestWsUrl()).toBe('wss://ingest.example.com');
  });

  it('ignores whitespace-only override', () => {
    withStubbedEnv({
      COMMAND: 'build',
      VITE_SESSION_INGEST_WS_URL: '   ',
    });
    expect(getSessionIngestWsUrl()).toBe('wss://ingest.kilosessions.ai');
  });

  it('returns production fallback during build when no override', () => {
    withStubbedEnv({ COMMAND: 'build' });
    expect(getSessionIngestWsUrl()).toBe('wss://ingest.kilosessions.ai');
  });

  it('returns local serve fallback during serve when no override', () => {
    withStubbedEnv({ COMMAND: 'serve' });
    expect(getSessionIngestWsUrl()).toBe('ws://localhost:8800');
  });

  it('override takes precedence over serve fallback', () => {
    withStubbedEnv({
      COMMAND: 'serve',
      VITE_SESSION_INGEST_WS_URL: 'wss://staging.example.com',
    });
    expect(getSessionIngestWsUrl()).toBe('wss://staging.example.com');
  });
});
