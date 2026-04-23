import { describe, expect, it, vi } from 'vitest';
import { reloadGatewaySecrets, type GatewayRpcDeps } from './gateway-rpc';

type ExecCall = Parameters<GatewayRpcDeps['execFileSync']>;

function makeDeps(overrides: Partial<GatewayRpcDeps> = {}): GatewayRpcDeps {
  return {
    execFileSync: vi.fn(() => ''),
    ...overrides,
  };
}

function firstCall(deps: GatewayRpcDeps): ExecCall {
  const mock = deps.execFileSync as unknown as { mock: { calls: ExecCall[] } };
  return mock.mock.calls[0];
}

describe('reloadGatewaySecrets', () => {
  it('invokes `openclaw secrets reload` with url and token', () => {
    const deps = makeDeps();
    const result = reloadGatewaySecrets({ token: 'gw-token-123' }, deps);

    expect(result).toEqual({ ok: true });
    expect(deps.execFileSync).toHaveBeenCalledOnce();
    const [cmd, args] = firstCall(deps);
    expect(cmd).toBe('openclaw');
    expect(args).toEqual([
      'secrets',
      'reload',
      '--url',
      'ws://127.0.0.1:3001',
      '--token',
      'gw-token-123',
      '--json',
    ]);
  });

  it('uses a custom port when provided', () => {
    const deps = makeDeps();
    reloadGatewaySecrets({ token: 't', port: 4000 }, deps);

    const [, args] = firstCall(deps);
    expect(args).toContain('ws://127.0.0.1:4000');
  });

  it('returns { ok: false, error } when the CLI fails', () => {
    const deps = makeDeps({
      execFileSync: vi.fn(() => {
        throw new Error('gateway not reachable');
      }),
    });

    const result = reloadGatewaySecrets({ token: 't' }, deps);

    expect(result).toEqual({ ok: false, error: 'gateway not reachable' });
  });

  it('redacts the token from the error message so it is safe to log', () => {
    // Node's execFileSync builds its error string from the full argv, so a
    // real throw would embed `--token <TOKEN>`. Simulate that shape and
    // confirm the token is scrubbed before it leaves the module.
    const token = 'super-secret-gateway-token';
    const deps = makeDeps({
      execFileSync: vi.fn(() => {
        throw new Error(
          `Command failed: openclaw secrets reload --url ws://127.0.0.1:3001 --token ${token} --json\nsome stderr`
        );
      }),
    });

    const result = reloadGatewaySecrets({ token }, deps);

    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error).not.toContain(token);
    expect(result.error).toContain('<redacted-token>');
  });

  it('also redacts the token when it appears multiple times in the error', () => {
    const token = 'super-secret-gateway-token';
    const deps = makeDeps({
      execFileSync: vi.fn(() => {
        throw new Error(`argv: --token ${token}; stderr: invalid token ${token}`);
      }),
    });

    const result = reloadGatewaySecrets({ token }, deps);

    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error).not.toContain(token);
  });

  it('coerces non-Error throws to strings', () => {
    const deps = makeDeps({
      execFileSync: vi.fn(() => {
        // Some versions of execFileSync throw plain objects with stderr etc.
        throw { code: 1 };
      }),
    });

    const result = reloadGatewaySecrets({ token: 't' }, deps);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(typeof result.error).toBe('string');
  });

  it('applies the timeout when provided', () => {
    const deps = makeDeps();
    reloadGatewaySecrets({ token: 't', timeoutMs: 5_000 }, deps);

    const [, , opts] = firstCall(deps);
    expect(opts).toMatchObject({ timeout: 5_000 });
  });
});
