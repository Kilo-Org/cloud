import { describe, expect, it } from 'vitest';
import {
  attachmentSpecFromRouteSpec,
  workspaceConfigFromSpec,
  workspaceConfigRuntimeKey,
} from './workspace-config.js';
import type { ControlPlaneRouteSpec } from './control-plane-protocol.js';

const HEAVY: Partial<ControlPlaneRouteSpec> = {
  env: { WORKSPACE_SETTING: 'creator', PRIVATE_SETTING: 'decrypted-value' },
  secretEnvKeys: ['PRIVATE_SETTING'],
  setupCommands: ['echo first'],
  runtimeSkills: [{ name: 'review', rawMarkdown: '# Review' }],
  runtimeAgents: [{ slug: 'helper', name: 'Helper', config: {} }],
  kiloCommands: [{ name: 'review', template: 'Review the change' }],
};

function spec(overrides: Partial<ControlPlaneRouteSpec> = {}): ControlPlaneRouteSpec {
  return {
    sessionId: 'workspace_11111111-1111-1111-1111-111111111111',
    kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    directory: '/workspace/shared',
    attemptId: 'attempt-1',
    ...HEAVY,
    ...overrides,
  };
}

describe('workspace config', () => {
  it('keys a shared runtime by directory and a per-session runtime by session', () => {
    expect(workspaceConfigRuntimeKey(spec())).toBe('/workspace/shared');
    expect(workspaceConfigRuntimeKey(spec({ runtimeIsolation: 'per-session' }))).toBe(
      'workspace_11111111-1111-1111-1111-111111111111'
    );
  });

  it('splits the heavy fields out of the attachment spec', () => {
    const attachment = attachmentSpecFromRouteSpec(spec());
    expect(attachment).not.toHaveProperty('setupCommands');
    expect(attachment).not.toHaveProperty('runtimeSkills');
    expect(attachment).not.toHaveProperty('runtimeAgents');
    expect(attachment).not.toHaveProperty('kiloCommands');
    expect(attachment).not.toHaveProperty('mcp');
    expect(attachment).not.toHaveProperty('env');
    expect(attachment).not.toHaveProperty('secretEnvKeys');
    expect(attachment.sessionId).toBe('workspace_11111111-1111-1111-1111-111111111111');
  });

  it('materializes only the workspace fields that are present', () => {
    expect(workspaceConfigFromSpec(HEAVY, undefined)).toEqual(HEAVY);
    expect(
      workspaceConfigFromSpec({ setupCommands: [] }, { local: { type: 'remote', url: 'u' } })
    ).toEqual({
      setupCommands: [],
      mcp: { local: { type: 'remote', url: 'u' } },
    });
  });
});
