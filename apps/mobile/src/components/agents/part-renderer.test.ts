/* eslint-disable max-lines -- Renderer routing, patch-summary, and mounted diff-line tests share the direct-invocation harness. */
import {
  type PatchPart,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { PartRenderer, patchPartFileLabel } from './part-renderer';
import { ReasoningPartRenderer } from './reasoning-part-renderer';
import { TextPartRenderer } from './text-part-renderer';
import { PatchToolCardBody } from './tool-cards/patch-tool-card';
import { ToolPartRenderer } from './tool-part-renderer';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('./child-session-section', () => ({}));
vi.mock('./compaction-separator', () => ({
  CompactionSeparator: () => null,
}));
vi.mock('./file-part-renderer', () => ({
  FilePartRenderer: () => null,
}));
vi.mock('./message-error-boundary', () => ({
  MessageErrorBoundary: ({ children }: { children?: unknown }) => children,
}));
vi.mock('./reasoning-part-renderer', () => ({
  ReasoningPartRenderer: () => null,
}));
vi.mock('./text-part-renderer', () => ({
  TextPartRenderer: () => null,
}));
vi.mock('./tool-part-renderer', () => ({
  ToolPartRenderer: () => null,
}));
// The patch part summary renders `View`/`Text`; the mounted patch-card test
// mounts the real `PatchToolCardBody` + `ToolPatchPreview` chain with only the
// leaf `DiffLine` mocked, so these module mocks keep React Native out of node.
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/diff/diff-line', () => ({ DiffLine: 'DiffLine' }));
vi.mock('@/components/ui/icons', () => ({ FileDiff: 'FileDiff' }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
vi.mock('./fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('./open-part-detail-context', () => ({ useOpenPartDetail: () => undefined }));
vi.mock('./tool-card-display', () => ({
  getToolDisplay: () => ({}),
  toolPartHasDetails: () => false,
}));
vi.mock('./tool-cards/generic-tool-card', () => ({ GenericToolCardBody: 'GenericToolCardBody' }));

function makeReasoningPart(text: string, ended = true): ReasoningPart {
  return {
    id: 'r1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text,
    time: { start: 1, end: ended ? 2 : undefined },
  };
}

function makeTextPart(text: string, synthetic?: boolean, ended = true): TextPart {
  const part: TextPart = {
    id: 't1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'text',
    text,
    time: { start: 1, end: ended ? 2 : undefined },
  };
  if (synthetic !== undefined) {
    part.synthetic = synthetic;
  }
  return part;
}

function makePatchPart(files: string[]): PatchPart {
  return {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'patch',
    hash: 'abc',
    files,
  };
}

const PATCH_TEXT = '*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch';

function makePatchState(
  tool: 'patch' | 'apply_patch',
  status: ToolPart['state']['status']
): ToolPart['state'] {
  const input = { patchText: PATCH_TEXT };
  const states: Record<ToolPart['state']['status'], ToolPart['state']> = {
    pending: { status: 'pending', input, raw: '' },
    running: { status: 'running', input, time: { start: 1 } },
    error: { status: 'error', input, error: 'patch failed', time: { start: 1, end: 2 } },
    completed: {
      status: 'completed',
      input,
      output: '',
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  return states[status];
}

function makePatchToolPart(
  tool: 'patch' | 'apply_patch',
  status: ToolPart['state']['status'] = 'completed'
): ToolPart {
  return {
    id: 'patch-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state: makePatchState(tool, status),
  };
}

function findAll(
  node: unknown,
  predicate: (el: React.ReactElement) => boolean
): React.ReactElement[] {
  const matches: React.ReactElement[] = [];
  function walk(value: unknown): void {
    if (value == null || typeof value === 'string' || typeof value === 'number') {
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      if (predicate(value)) {
        matches.push(value);
      }
      const props = value.props as Record<string, unknown>;
      if (typeof value.type === 'function') {
        walk((value.type as React.FunctionComponent<unknown>)(props));
      } else {
        walk(props.children);
      }
    }
  }
  walk(node);
  return matches;
}

function findText(root: unknown, text: string): React.ReactElement[] {
  return findAll(
    root,
    el => el.type === 'Text' && (el.props as { children?: unknown }).children === text
  );
}

async function mountPatchBody(part: ToolPart): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(React.createElement(PatchToolCardBody, { part }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function makeToolPart(): ToolPart {
  return {
    id: 'tool-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'echo hi' },
      output: 'hi',
      title: 'bash',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

const modelOptions: SessionModelOption[] = [
  {
    id: 'kilo/model',
    name: 'Test Model',
    displayId: 'model',
    variants: [],
    isPreferred: false,
    showGatewayMetadata: false,
    provider: { id: 'kilo', name: 'Kilo' },
    modelRef: { providerID: 'kilo', modelID: 'model' },
  },
];

describe('PartRenderer', () => {
  it('does not mount a completed empty reasoning part', () => {
    const part = makeReasoningPart('', true);
    // Intentionally invoke the component directly to test the routing seam
    // without pulling in React Native in the node test environment.
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, isStreaming: true });
    expect(result).toBeNull();
  });

  it('does not mount a streaming empty reasoning part', () => {
    const part = makeReasoningPart('', false);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, isStreaming: true });
    expect(result).toBeNull();
  });

  it('renders completed meaningful reasoning through the renderer seam', () => {
    const part = makeReasoningPart('Meaningful reasoning text', true);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, isStreaming: true });
    expect(result).not.toBeNull();
    const reasoningElement = (
      result as unknown as {
        props: { children: { type: unknown; props: Record<string, unknown> } };
      }
    ).props.children;
    expect(reasoningElement.type).toBe(ReasoningPartRenderer);
    expect(reasoningElement.props).toMatchObject({
      partId: 'r1',
      text: 'Meaningful reasoning text',
      isStreaming: false,
    });
  });

  it('returns null for snapshot-progress parts while streaming', () => {
    const part = makeTextPart('⠋ Initializing snapshot…', true, false);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, isStreaming: true });
    expect(result).toBeNull();
  });

  it('returns null for snapshot-progress parts when not streaming', () => {
    const part = makeTextPart('⠋ Initializing snapshot…', true, true);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, isStreaming: false });
    expect(result).toBeNull();
  });

  it('routes normal text parts to TextPartRenderer', () => {
    const part = makeTextPart('Hello world');
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, isStreaming: true });
    expect(result).not.toBeNull();
    const textElement = (
      result as unknown as {
        props: { children: { type: unknown; props: Record<string, unknown> } };
      }
    ).props.children;
    expect(textElement.type).toBe(TextPartRenderer);
    expect(textElement.props).toMatchObject({ text: 'Hello world' });
  });

  it('passes modelOptions through to ToolPartRenderer for a tool part', () => {
    const part = makeToolPart();
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, modelOptions });
    expect(result).not.toBeNull();
    const toolElement = (
      result as unknown as {
        props: { children: { type: unknown; props: Record<string, unknown> } };
      }
    ).props.children;
    expect(toolElement.type).toBe(ToolPartRenderer);
    expect(toolElement.props).toMatchObject({ modelOptions });
  });
});

describe('PartRenderer patch part summary', () => {
  // `/workspace/<userId>/sessions/<sessionId>` with the repo cloned at that
  // root (services/cloud-agent-next/src/workspace.ts:202).
  const WORKSPACE_ROOT = '/workspace/a7e4d40b-c28c-4df1-9a1e-f88e7eb467f1/sessions/W1s2';
  // `/workspace/<userId>/worktrees/<worktreeId>` is the root a worktree-backed
  // session clones into instead (services/cloud-agent-next/src/workspace.ts:211).
  const WORKTREE_ROOT =
    '/workspace/a7e4d40b-c28c-4df1-9a1e-f88e7eb467f1/worktrees/worktree_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

  it('renders the file count and paths for a patch part', () => {
    const part = makePatchPart(['src/a.ts', 'src/b.ts']);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part });
    expect(result).not.toBeNull();
    expect(findText(result, 'Updated 2 files')).toHaveLength(1);
    expect(findText(result, 'src/a.ts')).toHaveLength(1);
    expect(findText(result, 'src/b.ts')).toHaveLength(1);
  });

  it('uses the singular label for a single file', () => {
    const part = makePatchPart(['src/a.ts']);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part });
    expect(findText(result, 'Updated 1 file')).toHaveLength(1);
  });

  it('shows the repo-relative file name for an absolute workspace path', () => {
    const part = makePatchPart([`${WORKSPACE_ROOT}/README.md`]);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part });
    expect(result).not.toBeNull();
    expect(findText(result, 'README.md')).toHaveLength(1);
    expect(
      findAll(
        result,
        el =>
          el.type === 'Text' &&
          String((el.props as { children?: unknown }).children).includes('/workspace/')
      )
    ).toHaveLength(0);
  });

  it('keeps the nested repo-relative path for an absolute workspace path', () => {
    const part = makePatchPart([`${WORKSPACE_ROOT}/src/cli.test.ts`]);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part });
    expect(findText(result, 'src/cli.test.ts')).toHaveLength(1);
  });

  it('strips an org-scoped workspace prefix', () => {
    const part = makePatchPart(['/workspace/org-1/user-1/sessions/W1s2/src/a.ts']);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part });
    expect(findText(result, 'src/a.ts')).toHaveLength(1);
  });

  it('strips a worktree workspace prefix', () => {
    const part = makePatchPart([`${WORKTREE_ROOT}/README.md`]);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part });
    expect(result).not.toBeNull();
    expect(findText(result, 'README.md')).toHaveLength(1);
    expect(
      findAll(
        result,
        el =>
          el.type === 'Text' &&
          String((el.props as { children?: unknown }).children).includes('/workspace/')
      )
    ).toHaveLength(0);
  });

  it('strips an org-scoped worktree workspace prefix from a nested path', () => {
    expect(
      patchPartFileLabel('/workspace/org-1/user-1/worktrees/worktree_9b1deb4d/src/nested/a.ts')
    ).toBe('src/nested/a.ts');
  });

  it('renders each file row as a single middle-ellipsized line', () => {
    const part = makePatchPart([`${WORKSPACE_ROOT}/src/a.ts`]);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part });
    const [fileRow] = findAll(
      result,
      el => el.type === 'Text' && (el.props as { numberOfLines?: number }).numberOfLines === 1
    );
    expect(fileRow).toBeDefined();
    expect(fileRow?.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'middle' });
  });

  it('leaves a path without the workspace prefix untouched', () => {
    expect(patchPartFileLabel('src/a.ts')).toBe('src/a.ts');
  });

  it('strips the absolute workspace prefix from a nested path', () => {
    expect(patchPartFileLabel(`${WORKSPACE_ROOT}/src/nested/a.ts`)).toBe('src/nested/a.ts');
  });

  it('returns null for a patch part with no files', () => {
    const part = makePatchPart([]);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part });
    expect(result).toBeNull();
  });
});

describe('PatchToolCardBody mounted diff lines', () => {
  it.each(
    (['patch', 'apply_patch'] as const).flatMap(tool =>
      (['pending', 'running', 'completed', 'error'] as const).map(status => [tool, status] as const)
    )
  )('renders diff lines for tool %s in the %s state', async (tool, status) => {
    const renderer = await mountPatchBody(makePatchToolPart(tool, status));
    const diffLines = renderer.root.findAll(node => String(node.type) === 'DiffLine');
    expect(diffLines).toHaveLength(1);
    const errorLines = renderer.root.findAll(
      node => String(node.type) === 'SelectableText' && node.props.children === 'patch failed'
    );
    expect(errorLines).toHaveLength(status === 'error' ? 1 : 0);
  });
});
