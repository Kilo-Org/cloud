import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { loadRuntimeConfig } from './index';
import {
  DEFAULT_MAX_WS_CONNS,
  DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_WS_IDLE_TIMEOUT_MS,
} from './proxy';

function asEnv(value: Record<string, string>): NodeJS.ProcessEnv {
  return value as unknown as NodeJS.ProcessEnv;
}

describe('controller startup config', () => {
  it('fails fast when OPENCLAW_GATEWAY_TOKEN is missing', () => {
    expect(() =>
      loadRuntimeConfig(
        asEnv({
          KILOCLAW_GATEWAY_ARGS: '["--port","3001"]',
        })
      )
    ).toThrow('OPENCLAW_GATEWAY_TOKEN is required');
  });

  it('fails fast when KILOCLAW_GATEWAY_ARGS is missing', () => {
    expect(() =>
      loadRuntimeConfig(
        asEnv({
          OPENCLAW_GATEWAY_TOKEN: 'token',
        })
      )
    ).toThrow('KILOCLAW_GATEWAY_ARGS is required');
  });

  it('fails fast when KILOCLAW_GATEWAY_ARGS is invalid JSON', () => {
    expect(() =>
      loadRuntimeConfig(
        asEnv({
          OPENCLAW_GATEWAY_TOKEN: 'token',
          KILOCLAW_GATEWAY_ARGS: '{invalid-json}',
        })
      )
    ).toThrow('KILOCLAW_GATEWAY_ARGS must be valid JSON');
  });

  it('validates KILOCLAW_GATEWAY_ARGS as string array', () => {
    expect(() =>
      loadRuntimeConfig(
        asEnv({
          OPENCLAW_GATEWAY_TOKEN: 'token',
          KILOCLAW_GATEWAY_ARGS: '[1,2,3]',
        })
      )
    ).toThrow('KILOCLAW_GATEWAY_ARGS must be a JSON array of strings');
  });

  it('applies websocket hardening defaults', () => {
    const config = loadRuntimeConfig(
      asEnv({
        OPENCLAW_GATEWAY_TOKEN: 'token',
        KILOCLAW_GATEWAY_ARGS: '["--port","3001"]',
      })
    );

    expect(config.maxWsConnections).toBe(DEFAULT_MAX_WS_CONNS);
    expect(config.wsIdleTimeoutMs).toBe(DEFAULT_WS_IDLE_TIMEOUT_MS);
    expect(config.wsHandshakeTimeoutMs).toBe(DEFAULT_WS_HANDSHAKE_TIMEOUT_MS);
  });

  it('allows websocket hardening overrides from env', () => {
    const config = loadRuntimeConfig(
      asEnv({
        OPENCLAW_GATEWAY_TOKEN: 'token',
        KILOCLAW_GATEWAY_ARGS: '["--port","3001"]',
        MAX_WS_CONNS: '50',
        WS_IDLE_TIMEOUT_MS: '600000',
        WS_HANDSHAKE_TIMEOUT_MS: '3000',
      })
    );

    expect(config.maxWsConnections).toBe(50);
    expect(config.wsIdleTimeoutMs).toBe(600000);
    expect(config.wsHandshakeTimeoutMs).toBe(3000);
  });

  it('fails fast on invalid websocket hardening env values', () => {
    expect(() =>
      loadRuntimeConfig(
        asEnv({
          OPENCLAW_GATEWAY_TOKEN: 'token',
          KILOCLAW_GATEWAY_ARGS: '["--port","3001"]',
          MAX_WS_CONNS: '0',
        })
      )
    ).toThrow('MAX_WS_CONNS must be a positive integer');
  });

  it('serializes start-openclaw gateway args as JSON array', () => {
    const result = spawnSync(
      'node',
      [
        '-e',
        `
const args = ['--port', '3001', '--verbose', '--allow-unconfigured', '--bind', 'loopback'];
if (process.env.OPENCLAW_GATEWAY_TOKEN) {
  args.push('--token', process.env.OPENCLAW_GATEWAY_TOKEN);
}
process.stdout.write(JSON.stringify(args));
`,
      ],
      {
        env: {
          ...process.env,
          OPENCLAW_GATEWAY_TOKEN: 'tok-123',
        },
        encoding: 'utf8',
      }
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as string[];
    expect(parsed).toEqual([
      '--port',
      '3001',
      '--verbose',
      '--allow-unconfigured',
      '--bind',
      'loopback',
      '--token',
      'tok-123',
    ]);
  });
});
