import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { WorktreeBranchOperationResult as WorkerResult } from '@kilocode/worker-utils/cloud-agent-worktree-operations';

const mockRestack = jest.fn<() => Promise<WorkerResult>>();
const mockDispatch =
  jest.fn<
    (
      target: { worktreeId: string; cloudAgentSessionId: string },
      instruction: string
    ) => Promise<'sent' | 'manual' | 'failed'>
  >();
const mockRestackStack = jest.fn<
  (targets: readonly Target[]) => Promise<{
    results: Array<{ target: Target; result: WorkerResult }>;
    stopped: { target: Target; result: WorkerResult } | null;
  }>
>();

jest.mock('./useWorktreeBranchOperations', () => ({
  useWorktreeBranchOperations: () => ({
    isPending: false,
    lastResult: null,
    currentCloudAgentSessionId: 'workspace_root',
    restack: mockRestack,
    restackStack: mockRestackStack,
  }),
  buildBranchConflictInstruction: (_target: { worktreeId: string }, result: WorkerResult) =>
    'instruction' in result ? result.instruction : 'Resolve the conflict.',
  useWorktreeInstructionDispatcher: () => mockDispatch,
}));

jest.mock('@/components/ui/dialog', () => {
  const react = jest.requireActual<typeof React>('react');
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? react.createElement(react.Fragment, null, children) : null,
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogDescription: passthrough,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { StackedWorkspaceActions } = require('./StackedWorkspaceActions') as {
  StackedWorkspaceActions: React.ComponentType<Record<string, unknown>>;
};

type Target = {
  worktreeId: string;
  cloudAgentSessionId: string;
  branch: string;
  baseBranch: string;
  label: string;
  prNumber: number;
  prState: string;
  prUrl: string;
  stackNumber: number;
  stackPosition: number;
  isRoot: boolean;
};

const target: Target = {
  worktreeId: 'worktree_root',
  cloudAgentSessionId: 'workspace_root',
  branch: 'feat/a',
  baseBranch: 'main',
  label: 'Root',
  prNumber: 1,
  prState: 'open',
  prUrl: 'https://github.com/acme/repo/pull/1',
  stackNumber: 1,
  stackPosition: 0,
  isRoot: true,
};

const layer: Target = {
  ...target,
  worktreeId: 'worktree_child',
  cloudAgentSessionId: 'workspace_child',
  branch: 'feat/b',
  baseBranch: 'feat/a',
  label: 'Child',
  prNumber: 2,
  prUrl: 'https://github.com/acme/repo/pull/2',
  stackPosition: 1,
  isRoot: false,
};

function result(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    status: 'changed',
    operation: 'sync',
    branch: 'feat/a',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    previousRemoteSha: 'b'.repeat(40),
    remoteSha: 'c'.repeat(40),
    headSha: 'd'.repeat(40),
    ...overrides,
  } as WorkerResult;
}

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(name => [name, globals[name]]));
  Object.assign(globals, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('StackedWorkspaceActions test root missing');
  document.getSelection = () => null;
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

function text(container: Element): string {
  return container.textContent ?? '';
}

describe('StackedWorkspaceActions', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;

  beforeEach(() => {
    dom = installDom();
    root = createRoot(dom.container);
    mockRestack.mockReset();
    mockRestackStack.mockReset();
    mockDispatch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.cleanup();
  });

  const render = async (
    onSendInstruction = jest.fn<(instruction: string) => Promise<boolean>>(async () => true)
  ) => {
    await act(async () => {
      root.render(
        React.createElement(StackedWorkspaceActions, {
          open: true,
          onOpenChange: () => undefined,
          worktreeId: target.worktreeId,
          cloudAgentSessionId: target.cloudAgentSessionId,
          branch: target.branch,
          baseBranch: target.baseBranch,
          stack: [target, layer],
          onSendInstruction,
        })
      );
    });
    return onSendInstruction;
  };

  const click = async (label: string) => {
    const buttons = [...dom.container.querySelectorAll('button')];
    const button = buttons.find(candidate => text(candidate).trim() === label);
    if (!button) throw new Error(`Missing button ${label}`);
    await act(async () => {
      const EventCtor = dom.container.ownerDocument.defaultView?.Event ?? Event;
      button.dispatchEvent(new EventCtor('click', { bubbles: true }));
    });
  };

  it('sends a conflict instruction automatically and only retries after an explicit click', async () => {
    mockDispatch.mockResolvedValue('manual');
    mockRestack.mockResolvedValue(
      result({
        status: 'conflict',
        operation: 'restack',
        files: ['src/a.ts'],
        command: 'git rebase --onto main abc',
        instruction: 'Resolve src/a.ts and run tests.',
      })
    );
    await render();
    await click('Restack');

    expect(mockRestack).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(target, 'Resolve src/a.ts and run tests.');
    expect(text(dom.container)).toContain(
      'The conflict instruction was not sent. Review it and try again.'
    );

    await click('Send to agent');
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('does not claim a restack succeeded when the server only synced', async () => {
    mockRestack.mockResolvedValue(result({ status: 'changed', operation: 'sync' }));
    await render();
    await click('Restack');

    expect(text(dom.container)).toContain(
      'GitHub had already rebased this layer, so this was applied as a sync. Retry Restack to verify the branch.'
    );
    expect(text(dom.container)).not.toContain('Restacked the branch.');
  });

  it('runs the stack action only from the root and reports the layer count', async () => {
    mockRestackStack.mockResolvedValue({
      results: [
        { target, result: result({ status: 'changed' }) },
        { target: layer, result: result({ status: 'unchanged' }) },
      ],
      stopped: null,
    });
    await render();
    await click('Restack stack');

    expect(mockRestackStack).toHaveBeenCalledWith([target, layer]);
    expect(text(dom.container)).toContain('Restacked 1 layer.');
  });
});
