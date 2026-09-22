import { describe, expect, it } from 'bun:test';
import { decideKiloRuntimeStart, type KiloRuntimeStartDecisionInput } from './kilo-runtime-start';

const WORKSPACE = '/workspace/repo';

function decide(overrides: Partial<KiloRuntimeStartDecisionInput> = {}): 'reuse' | 'start' {
  return decideKiloRuntimeStart({
    forceRestart: false,
    hasClient: true,
    runtimeWorkspacePath: WORKSPACE,
    workspacePath: WORKSPACE,
    ...overrides,
  });
}

describe('decideKiloRuntimeStart', () => {
  it('reuses a live client on the same workspace without a forced restart', () => {
    expect(decide()).toBe('reuse');
  });

  it('starts without a live client', () => {
    expect(decide({ hasClient: false })).toBe('start');
  });

  it('starts when a restart is forced', () => {
    expect(decide({ forceRestart: true })).toBe('start');
  });

  it('starts when the runtime workspace differs', () => {
    expect(decide({ runtimeWorkspacePath: '/workspace/other' })).toBe('start');
  });

  it('starts when no runtime workspace is recorded', () => {
    expect(decide({ runtimeWorkspacePath: undefined })).toBe('start');
  });

  it('reuses a live client when a legacy delivery carries a different credential', () => {
    const legacyInput: KiloRuntimeStartDecisionInput & {
      spawnEnv: Record<string, string>;
      deliveredEnv: Record<string, string>;
    } = {
      forceRestart: false,
      hasClient: true,
      runtimeWorkspacePath: WORKSPACE,
      workspacePath: WORKSPACE,
      spawnEnv: { KILOCODE_TOKEN: 'A' },
      deliveredEnv: { KILOCODE_TOKEN: 'B' },
    };

    expect(decideKiloRuntimeStart(legacyInput)).toBe('reuse');
  });
});
