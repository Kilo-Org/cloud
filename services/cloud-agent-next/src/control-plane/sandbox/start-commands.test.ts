import { describe, expect, it } from 'vitest';
import type { ControlPlaneRouteSpec } from '../../shared/control-plane-protocol.js';
import { startCommandsForWrapper, WrapperStartCommandsUnsupportedError } from './start-commands.js';

const spec: ControlPlaneRouteSpec = {
  sessionId: 'ses_a',
  kiloSessionId: 'kilo_a',
  attemptId: 'attempt-1',
  directory: '/workspace',
  setupCommands: ['install'],
  startCommands: ['serve'],
  environmentSetupCommandCount: 1,
};

const snapshotSpec: ControlPlaneRouteSpec = {
  ...spec,
  workspaceSnapshot: {
    sourceAllocationId: 'alloc-source',
    workspaceId: 'worktree_00000000-0000-4000-8000-000000000001' as const,
    directory: '/workspace',
  },
};

describe('startCommandsForWrapper', () => {
  it('keeps start commands apart for a wrapper that runs them', () => {
    expect(startCommandsForWrapper(spec, true)).toBe(spec);
  });

  it('appends start commands to setup for a wrapper that predates them', () => {
    const result = startCommandsForWrapper(spec, false);
    expect(result.setupCommands).toEqual(['install', 'serve']);
    expect(result).not.toHaveProperty('startCommands');
    expect(result).not.toHaveProperty('environmentSetupCommandCount');
  });

  it('leaves setup untouched for an older wrapper when there are no start commands', () => {
    const result = startCommandsForWrapper({ ...spec, startCommands: undefined }, false);
    expect(result.setupCommands).toEqual(['install']);
    expect(result).not.toHaveProperty('startCommands');
    expect(result).not.toHaveProperty('environmentSetupCommandCount');
  });

  it('fails instead of dropping start commands when an older wrapper restores a workspace tail snapshot', () => {
    expect(() => startCommandsForWrapper(snapshotSpec, false)).toThrow(
      WrapperStartCommandsUnsupportedError
    );
  });

  it('keeps start commands apart for a wrapper that runs them during a workspace tail snapshot restore', () => {
    expect(startCommandsForWrapper(snapshotSpec, true)).toBe(snapshotSpec);
  });

  it('leaves a workspace tail snapshot restore without start commands unchanged for an older wrapper', () => {
    const result = startCommandsForWrapper({ ...snapshotSpec, startCommands: undefined }, false);
    expect(result.setupCommands).toEqual(['install']);
    expect(result).not.toHaveProperty('startCommands');
    expect(result).not.toHaveProperty('environmentSetupCommandCount');
    expect(result.workspaceSnapshot).toEqual(snapshotSpec.workspaceSnapshot);
  });
});
