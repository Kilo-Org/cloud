import { describe, it, expect } from 'vitest';
import { loadRuntimeConfig, toPublicDegradedError } from './index';
import { buildGatewayArgs } from './bootstrap';
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

  it('buildGatewayArgs output is accepted by loadRuntimeConfig', () => {
    const args = buildGatewayArgs({ OPENCLAW_GATEWAY_TOKEN: 'tok-123' });
    const serialized = JSON.stringify(args);

    const config = loadRuntimeConfig(
      asEnv({
        OPENCLAW_GATEWAY_TOKEN: 'tok-123',
        KILOCLAW_GATEWAY_ARGS: serialized,
      })
    );

    expect(config.gatewayArgs).toEqual(args);
    expect(config.expectedToken).toBe('tok-123');
  });
});

describe('toPublicDegradedError', () => {
  it('returns a generic message with the stage name', () => {
    expect(toPublicDegradedError('bootstrap')).toBe('Startup failed during bootstrap');
  });

  it('does not include raw error details', () => {
    // The function takes only a stage name, not the raw error.
    // Raw errors (which may contain secrets like --kilocode-api-key)
    // are logged to stdout only and never stored in controller state.
    const result = toPublicDegradedError('runtime-config');
    expect(result).toBe('Startup failed during runtime-config');
    expect(result).not.toContain('secret');
  });

  it('covers all degraded-state transitions', () => {
    expect(toPublicDegradedError('bootstrap')).toMatch(/^Startup failed during /);
    expect(toPublicDegradedError('runtime-config')).toMatch(/^Startup failed during /);
    expect(toPublicDegradedError('post-bootstrap')).toMatch(/^Startup failed during /);
  });
});
