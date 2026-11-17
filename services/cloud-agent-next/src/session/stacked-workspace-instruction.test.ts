import { describe, expect, it } from 'vitest';
import {
  stackedWorkspaceInstruction,
  withStackedWorkspaceInstruction,
} from './stacked-workspace-instruction.js';

describe('stacked workspace instruction', () => {
  it('appends one instruction that names the base and the own branch', () => {
    const result = withStackedWorkspaceInstruction('Be concise.', 'feat/parent', 'kilo/mine');
    expect(result).toBe(
      `Be concise.\n\n${stackedWorkspaceInstruction('feat/parent', 'kilo/mine')}`
    );
    expect(result).toContain('--base feat/parent');
    expect(result).toContain('Do not rebase or push branches other than `kilo/mine`');
  });

  it('replaces the previous instruction when a restack retargets the base', () => {
    const first = withStackedWorkspaceInstruction(undefined, 'feat/old', 'kilo/mine');
    const second = withStackedWorkspaceInstruction(first, 'feat/new', 'kilo/mine');

    expect(second).not.toContain('feat/old');
    expect(second).toContain('--base feat/new');
    expect(second?.match(/This workspace is stacked on/g)).toHaveLength(1);
  });

  it('removes the instruction when the base is cleared', () => {
    const first = withStackedWorkspaceInstruction('Be concise.', 'feat/old', 'kilo/mine');
    expect(withStackedWorkspaceInstruction(first, undefined, 'kilo/mine')).toBe('Be concise.');
    expect(withStackedWorkspaceInstruction(undefined, undefined, 'kilo/mine')).toBeUndefined();
  });
});
