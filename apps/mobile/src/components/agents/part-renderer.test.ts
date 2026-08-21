/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/test/render-with-providers.tsx */
import {
  type PatchPart,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { PartRenderer } from './part-renderer';
import { ReasoningPartRenderer } from './reasoning-part-renderer';
import { TextPartRenderer } from './text-part-renderer';
import { PatchToolCardBody } from './tool-cards/patch-tool-card';

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
});

describe('PartRenderer patch part summary', () => {
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
