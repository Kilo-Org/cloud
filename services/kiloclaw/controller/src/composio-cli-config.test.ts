import { describe, expect, it, vi } from 'vitest';
import {
  clearComposioCliEnv,
  loginComposioCli,
  type ComposioCliLoginDeps,
} from './composio-cli-config';

function fakeDeps() {
  const execCalls: {
    cmd: string;
    args: string[];
    opts: { stdio: 'ignore'; env: NodeJS.ProcessEnv };
  }[] = [];
  const deps: ComposioCliLoginDeps = {
    execFileSync: vi.fn((cmd, args, opts) => {
      execCalls.push({ cmd, args, opts });
    }),
  };

  return { deps, execCalls };
}

describe('loginComposioCli', () => {
  it('returns false when user API key is missing', () => {
    const { deps, execCalls } = fakeDeps();

    const result = loginComposioCli({ COMPOSIO_ORG: 'syn_workspace' }, deps);

    expect(result).toBe(false);
    expect(execCalls).toEqual([]);
  });

  it('returns false when organization is missing', () => {
    const { deps, execCalls } = fakeDeps();

    const result = loginComposioCli(
      { COMPOSIO_USER_API_KEY: 'uak_FAKE_TEST_KEY_1234567890' },
      deps
    );

    expect(result).toBe(false);
    expect(execCalls).toEqual([]);
  });

  it('runs composio login when both values are present', () => {
    const { deps, execCalls } = fakeDeps();
    const env = {
      COMPOSIO_USER_API_KEY: ' uak_FAKE_TEST_KEY_1234567890 ',
      COMPOSIO_ORG: ' syn_workspace ',
      KILOCODE_API_KEY: 'kc_keep',
    };

    const result = loginComposioCli(env, deps);

    expect(result).toBe(true);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe('composio');
    expect(execCalls[0].args).toEqual([
      'login',
      '--user-api-key',
      'uak_FAKE_TEST_KEY_1234567890',
      '--org',
      'syn_workspace',
    ]);
    expect(execCalls[0].opts.stdio).toBe('ignore');
    expect(execCalls[0].opts.env).toBe(env);
  });
});

describe('clearComposioCliEnv', () => {
  it('removes Composio credentials from the provided env', () => {
    const env = {
      COMPOSIO_USER_API_KEY: 'uak_FAKE_TEST_KEY_1234567890',
      COMPOSIO_ORG: 'syn_workspace',
      KILOCODE_API_KEY: 'kc_keep',
    };

    clearComposioCliEnv(env);

    expect(env).toEqual({ KILOCODE_API_KEY: 'kc_keep' });
  });
});
