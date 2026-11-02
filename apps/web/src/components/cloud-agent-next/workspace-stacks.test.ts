import { describe, expect, it } from '@jest/globals';
import {
  buildWorkspaceStacks,
  getMostUrgentStackStatus,
  resolveStackedWorkspaceAvailability,
  selectWorkspaceStack,
  type WorkspaceStackNode,
} from './workspace-stacks';

function node(worktreeId: string, overrides: Partial<WorkspaceStackNode> = {}): WorkspaceStackNode {
  return {
    worktreeId,
    parentWorktreeId: null,
    branch: worktreeId,
    baseBranch: null,
    repositoryKey: 'github.com/acme/repo',
    pr: null,
    ...overrides,
  };
}

function pr(overrides: Partial<NonNullable<WorkspaceStackNode['pr']>> = {}) {
  return {
    number: 1,
    url: null,
    state: 'open',
    baseRef: null,
    stackNumber: null,
    stackPosition: null,
    stackSize: null,
    headSha: null,
    ...overrides,
  };
}

describe('buildWorkspaceStacks', () => {
  it('nests explicit parent links depth first and lists each worktree once', () => {
    const stacks = buildWorkspaceStacks([
      node('child', { parentWorktreeId: 'middle', branch: 'feat/child' }),
      node('root', { branch: 'feat/root' }),
      node('middle', { parentWorktreeId: 'root', branch: 'feat/middle' }),
    ]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.rootWorktreeId).toBe('root');
    expect(stacks[0]?.entries.map(entry => [entry.node.worktreeId, entry.depth])).toEqual([
      ['root', 0],
      ['middle', 1],
      ['child', 2],
    ]);
  });

  it('infers a stack chain from a shared PR stack number', () => {
    const stacks = buildWorkspaceStacks([
      node('b', { branch: 'feat/b', pr: pr({ stackNumber: 7, stackPosition: 2 }) }),
      node('a', { branch: 'feat/a', pr: pr({ stackNumber: 7, stackPosition: 1 }) }),
    ]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.entries.map(entry => entry.node.worktreeId)).toEqual(['a', 'b']);
  });

  it('infers a parent from the PR base ref only within the same repository', () => {
    const stacks = buildWorkspaceStacks([
      node('parent', { branch: 'feat/base', repositoryKey: 'github.com/acme/repo' }),
      node('child', {
        branch: 'feat/child',
        pr: pr({ baseRef: 'feat/base' }),
        repositoryKey: 'github.com/acme/repo',
      }),
      node('other-provider', {
        branch: 'feat/other',
        pr: pr({ baseRef: 'feat/base' }),
        repositoryKey: 'gitlab.com/acme/repo',
      }),
    ]);
    expect(stacks.map(stack => stack.entries.map(entry => entry.node.worktreeId))).toEqual([
      ['parent', 'child'],
      ['other-provider'],
    ]);
  });

  it('keeps a cycle deterministic instead of dropping entries', () => {
    const stacks = buildWorkspaceStacks([
      node('a', { parentWorktreeId: 'b' }),
      node('b', { parentWorktreeId: 'a' }),
    ]);
    expect(
      stacks.flatMap(stack => stack.entries.map(entry => entry.node.worktreeId)).sort()
    ).toEqual(['a', 'b']);
  });

  it('rejects an explicit parent link from another repository', () => {
    const stacks = buildWorkspaceStacks([
      node('parent', { repositoryKey: 'github.com/acme/repo' }),
      node('child', {
        parentWorktreeId: 'parent',
        repositoryKey: 'gitlab.com/acme/repo',
      }),
      node('same-repo-child', {
        parentWorktreeId: 'parent',
        repositoryKey: 'github.com/acme/repo',
      }),
    ]);

    expect(stacks.map(stack => stack.entries.map(entry => entry.node.worktreeId))).toEqual([
      ['parent', 'same-repo-child'],
      ['child'],
    ]);
  });

  it('keeps a durable parent link when one side only has a display-name key', () => {
    const stacks = buildWorkspaceStacks([
      node('parent', { repositoryKey: 'github:acme/repo' }),
      node('child', {
        parentWorktreeId: 'parent',
        repositoryKey: 'github.com/acme/repo',
      }),
    ]);

    expect(stacks.map(stack => stack.entries.map(entry => entry.node.worktreeId))).toEqual([
      ['parent', 'child'],
    ]);
  });
});

describe('selectWorkspaceStack', () => {
  const nodes = [
    node('root', { branch: 'feat/root' }),
    node('middle', { parentWorktreeId: 'root', branch: 'feat/middle' }),
    node('child', { parentWorktreeId: 'middle', branch: 'feat/child' }),
    node('sibling', { parentWorktreeId: 'root', branch: 'feat/sibling' }),
  ];

  it('keeps every descendant target when the selected worktree is the root', () => {
    const selection = selectWorkspaceStack(nodes, 'root');

    expect(selection.stack?.rootWorktreeId).toBe('root');
    expect(selection.stack?.entries.map(entry => entry.node.worktreeId)).toEqual([
      'root',
      'middle',
      'child',
      'sibling',
    ]);
    expect(selection.ancestorIds).toEqual(['root']);
  });

  it('keeps the full stack while the breadcrumb stops at the selected worktree', () => {
    const selection = selectWorkspaceStack(nodes, 'middle');

    expect(selection.stack?.entries.map(entry => entry.node.worktreeId)).toEqual([
      'root',
      'middle',
      'child',
      'sibling',
    ]);
    expect(selection.ancestorIds).toEqual(['root', 'middle']);
  });

  it('stops at a parent that is not loaded instead of looping or inventing a chain', () => {
    const selection = selectWorkspaceStack(
      [node('child', { parentWorktreeId: 'missing' })],
      'child'
    );

    expect(selection.stack?.entries.map(entry => entry.node.worktreeId)).toEqual(['child']);
    expect(selection.ancestorIds).toEqual(['child']);
  });

  it('bounds ancestry on a cycle without dropping the stack', () => {
    const selection = selectWorkspaceStack(
      [node('a', { parentWorktreeId: 'b' }), node('b', { parentWorktreeId: 'a' })],
      'a'
    );

    expect(selection.stack?.entries.map(entry => entry.node.worktreeId).sort()).toEqual(['a', 'b']);
    expect(selection.ancestorIds).toHaveLength(2);
    expect(selection.ancestorIds.at(-1)).toBe('a');
  });
});

describe('resolveStackedWorkspaceAvailability', () => {
  it('keeps the root action available from the fallback before preflight loads', () => {
    expect(
      resolveStackedWorkspaceAvailability({
        source: undefined,
        isPending: false,
        isError: false,
        fallbackCanCreate: true,
        fallbackDisabledReason: null,
      })
    ).toEqual({ canCreateStackedWorkspace: true, createStackedWorkspaceDisabledReason: null });
  });

  it('trusts the authoritative preflight and disables an unpushed parent branch', () => {
    expect(
      resolveStackedWorkspaceAvailability({
        source: { basePushed: true, branch: 'feat/root' },
        isPending: false,
        isError: false,
        fallbackCanCreate: false,
        fallbackDisabledReason: 'stale',
      })
    ).toEqual({ canCreateStackedWorkspace: true, createStackedWorkspaceDisabledReason: null });

    expect(
      resolveStackedWorkspaceAvailability({
        source: { basePushed: false, branch: 'feat/root' },
        isPending: false,
        isError: false,
        fallbackCanCreate: true,
        fallbackDisabledReason: null,
      })
    ).toEqual({
      canCreateStackedWorkspace: false,
      createStackedWorkspaceDisabledReason:
        'Push `feat/root` first; it will be pushed after the next successful turn, or enable auto-commit',
    });
  });

  it('stays disabled while the preflight is pending or failed', () => {
    expect(
      resolveStackedWorkspaceAvailability({
        source: undefined,
        isPending: true,
        isError: false,
        fallbackCanCreate: true,
        fallbackDisabledReason: null,
      }).canCreateStackedWorkspace
    ).toBe(false);
    expect(
      resolveStackedWorkspaceAvailability({
        source: undefined,
        isPending: false,
        isError: true,
        fallbackCanCreate: true,
        fallbackDisabledReason: null,
      }).canCreateStackedWorkspace
    ).toBe(false);
  });
});

describe('getMostUrgentStackStatus', () => {
  it('prefers attention over running and failed, and idle for none', () => {
    expect(getMostUrgentStackStatus(['idle', 'failed', 'busy'])).toBe('running');
    expect(getMostUrgentStackStatus(['busy', 'permission'])).toBe('attention');
    expect(getMostUrgentStackStatus([null, 'completed'])).toBe('idle');
  });
});
