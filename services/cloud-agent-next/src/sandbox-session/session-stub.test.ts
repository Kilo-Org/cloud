import { describe, expect, it, vi } from 'vitest';
import { getSandboxSessionStub, resolveSessionStub, type SessionStubEnv } from './session-stub.js';

function namespace(name: string) {
  const idFromName = vi.fn((key: string) => `${name}:${key}`);
  const get = vi.fn((id: string) => ({ binding: name, id }));
  return { idFromName, get };
}

describe('resolveSessionStub', () => {
  it('routes agent_ to CLOUD_AGENT_SESSION and workspace_ to SANDBOX_SESSION', () => {
    const env = {
      CLOUD_AGENT_SESSION: namespace('legacy'),
      SANDBOX_SESSION: namespace('control'),
    };

    expect(
      resolveSessionStub(
        env as unknown as SessionStubEnv,
        'user-1',
        'agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      )
    ).toEqual({
      binding: 'legacy',
      id: 'legacy:user-1:agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith(
      'user-1:agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();

    expect(
      resolveSessionStub(
        env as unknown as SessionStubEnv,
        'user-1',
        'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      )
    ).toEqual({
      binding: 'control',
      id: 'control:user-1:workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    expect(env.SANDBOX_SESSION.idFromName).toHaveBeenCalledWith(
      'user-1:workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
  });

  it('builds SANDBOX_SESSION stubs for SandboxControl without reading the prefix', () => {
    const env = { SANDBOX_SESSION: namespace('control') } as unknown as Pick<
      SessionStubEnv,
      'SANDBOX_SESSION'
    >;
    expect(
      getSandboxSessionStub(env, 'user-1', 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    ).toEqual({
      binding: 'control',
      id: 'control:user-1:workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
  });
});
