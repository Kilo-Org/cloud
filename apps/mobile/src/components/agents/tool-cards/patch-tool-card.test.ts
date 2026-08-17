import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ToolPatchModel } from '../tool-patch-model';
import { PatchToolCard, PatchToolCardBody } from './patch-tool-card';
import * as React from 'react';

vi.mock('react-native', () => ({ View: 'View', TextInput: 'TextInput' }));
vi.mock('@/components/ui/icons', () => ({ FileDiff: 'FileDiff', Plug: 'Plug' }));
// Real context so the shared `SelectableText` can call `useContext(TextClassContext)`.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return {
    Text: 'Text',
    TextClassContext: createContext<string | undefined>(undefined),
  };
});
vi.mock('../bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('../mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
vi.mock('../fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('../tool-patch-preview', () => ({ ToolPatchPreview: 'ToolPatchPreview' }));
vi.mock('./generic-tool-card', () => ({ GenericToolCardBody: 'GenericToolCardBody' }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>();
  return {
    default: actual,
    ...actual,
    useMemo: <T>(fn: () => T): T => fn(),
    // `SelectableText` is invoked directly by the pure walker, outside a React
    // render, so the real `useContext` would throw on the null dispatcher.
    useContext: () => undefined,
  };
});

const { buildToolPatchModel } = vi.hoisted(() => ({
  buildToolPatchModel: vi.fn(),
}));
vi.mock('../tool-patch-model', () => ({ buildToolPatchModel }));

const { getToolDisplay, toolPartHasDetails, openSpy } = vi.hoisted(() => ({
  getToolDisplay: vi.fn(),
  toolPartHasDetails: vi.fn(),
  openSpy: vi.fn(),
}));
vi.mock('../tool-card-display', () => ({ getToolDisplay, toolPartHasDetails }));
vi.mock('../open-part-detail-context', () => ({ useOpenPartDetail: () => openSpy }));

// Constant from the patch card, duplicated here for the focused assertion.
const PATCH_FALLBACK_CHARACTER_CAP = 100_000;

function makeCompletedState(
  patchText: string
): Extract<ToolPart['state'], { status: 'completed' }> {
  return {
    status: 'completed',
    input: { patchText },
    output: '',
    title: 'apply_patch',
    metadata: {},
    time: { start: 0, end: 1 },
  };
}

function makeErrorState(
  patchText: string,
  error: string
): Extract<ToolPart['state'], { status: 'error' }> {
  return {
    status: 'error',
    input: { patchText },
    error,
    time: { start: 0, end: 1 },
  };
}

function makePatchPart(overrides: {
  patchText?: string;
  status?: 'completed' | 'error';
  error?: string;
  tool?: string;
}): ToolPart {
  const patchText =
    overrides.patchText ?? '*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch';
  const state: ToolPart['state'] =
    overrides.status === 'error'
      ? makeErrorState(patchText, overrides.error ?? 'failed')
      : makeCompletedState(patchText);

  return {
    id: 'patch-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: overrides.tool ?? 'apply_patch',
    state,
  };
}

function makeModel(): ToolPatchModel {
  return {
    files: [
      {
        path: 'src/app.ts',
        operation: 'update',
        lines: [
          { type: 'del', oldLine: 1, text: 'old', noNewlineAtEndOfFile: false },
          { type: 'add', newLine: 1, text: 'new', noNewlineAtEndOfFile: false },
        ],
        language: 'typescript',
      },
    ],
    truncated: false,
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
      // Walk the rendered output of function components so their
      // children are visible to predicate matching.
      if (typeof value.type === 'function') {
        walk((value.type as React.FunctionComponent<unknown>)(props));
      }
      walk(props.children);
    }
  }
  walk(node);
  return matches;
}

function findByType(root: React.ReactElement, type: string): React.ReactElement[] {
  return findAll(root, el => el.type === type);
}

describe('PatchToolCard — fixed row', () => {
  beforeEach(() => {
    getToolDisplay.mockReset();
    toolPartHasDetails.mockReset();
    openSpy.mockReset();
  });

  it('renders a FixedPartRow with the display projection and status', () => {
    getToolDisplay.mockReturnValue({ title: 'patch', subtitle: 'app.ts' });
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = PatchToolCard({ part: makePatchPart({}) }) as unknown as React.ReactElement;
    const rows = findByType(root, 'FixedPartRow');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) {
      throw new Error('row not found');
    }
    const rowProps = row.props as {
      icon: string;
      label: string;
      status: string;
      accessibilityLabel: string;
      badge?: unknown;
    };
    expect(rowProps).toMatchObject({
      icon: 'FileDiff',
      label: 'app.ts',
      status: 'completed',
      accessibilityLabel: 'app.ts tool, completed',
    });
    expect(rowProps.badge).toBeUndefined();
  });

  it('wires onPress to openPartDetail with the part id when details exist', () => {
    getToolDisplay.mockReturnValue({ title: 'patch', subtitle: 'app.ts' });
    toolPartHasDetails.mockReturnValue(true);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = PatchToolCard({ part: makePatchPart({}) }) as unknown as React.ReactElement;
    const row = findByType(root, 'FixedPartRow')[0];
    if (!row) {
      throw new Error('row not found');
    }
    const onPress = (row.props as { onPress?: unknown }).onPress as () => void;
    expect(onPress).toBeTypeOf('function');
    onPress();
    expect(openSpy).toHaveBeenCalledWith('patch-1');
  });

  it('leaves onPress undefined when details do not exist', () => {
    getToolDisplay.mockReturnValue({ title: 'patch', subtitle: 'app.ts' });
    toolPartHasDetails.mockReturnValue(false);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = PatchToolCard({ part: makePatchPart({}) }) as unknown as React.ReactElement;
    const row = findByType(root, 'FixedPartRow')[0];
    if (!row) {
      throw new Error('row not found');
    }
    expect((row.props as { onPress?: unknown }).onPress).toBeUndefined();
  });
});

describe('PatchToolCardBody — preview routing', () => {
  beforeEach(() => {
    buildToolPatchModel.mockReset();
  });

  it('renders ToolPatchPreview when the model exists', () => {
    const model = makeModel();
    buildToolPatchModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = PatchToolCardBody({ part: makePatchPart({}) }) as unknown as React.ReactElement;
    const previews = findByType(root, 'ToolPatchPreview');
    expect(previews).toHaveLength(1);
    expect(findByType(root, 'GenericToolCardBody')).toHaveLength(0);
  });

  it('passes the model and partId to ToolPatchPreview', () => {
    const model = makeModel();
    buildToolPatchModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = PatchToolCardBody({ part: makePatchPart({}) }) as unknown as React.ReactElement;
    const preview = findByType(root, 'ToolPatchPreview')[0];
    expect(preview).toBeDefined();
    if (!preview) {
      throw new Error('preview not found');
    }
    expect((preview.props as { model: unknown }).model).toBe(model);
    expect((preview.props as { partId: unknown }).partId).toBe('patch-1');
  });

  it('renders the bounded generic body exactly once when the model is null', () => {
    buildToolPatchModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = PatchToolCardBody({
      part: makePatchPart({ patchText: 'not a patch' }),
    }) as unknown as React.ReactElement;
    const genericBodies = findByType(root, 'GenericToolCardBody');
    expect(genericBodies).toHaveLength(1);
    expect(findByType(root, 'ToolPatchPreview')).toHaveLength(0);
    const generic = genericBodies[0];
    if (!generic) {
      throw new Error('generic body not found');
    }
    expect((generic.props as { inputMaxLength?: unknown }).inputMaxLength).toBe(
      PATCH_FALLBACK_CHARACTER_CAP
    );
    expect((generic.props as { part?: unknown }).part).toBeDefined();
  });

  it('renders the preview plus one error line for an error state with parseable input', () => {
    const model = makeModel();
    buildToolPatchModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = PatchToolCardBody({
      part: makePatchPart({ status: 'error', error: 'something went wrong' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolPatchPreview')).toHaveLength(1);
    const inputs = findByType(root, 'TextInput');
    const errorInputs = inputs.filter(
      el => (el.props as { value?: unknown }).value === 'something went wrong'
    );
    expect(errorInputs).toHaveLength(1);
  });

  it('leaves the single error line to the generic body for garbage input (no duplication)', () => {
    buildToolPatchModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = PatchToolCardBody({
      part: makePatchPart({ patchText: 'garbage', status: 'error', error: 'patch failed' }),
    }) as unknown as React.ReactElement;
    const genericBodies = findByType(root, 'GenericToolCardBody');
    expect(genericBodies).toHaveLength(1);
    const generic = genericBodies[0];
    if (!generic) {
      throw new Error('generic body not found');
    }
    expect((generic.props as { part?: unknown }).part).toBeDefined();
    expect((generic.props as { inputMaxLength?: unknown }).inputMaxLength).toBe(
      PATCH_FALLBACK_CHARACTER_CAP
    );
    // The patch body renders nothing else — the generic body owns the error line.
    expect(findByType(root, 'ToolPatchPreview')).toHaveLength(0);
    expect(
      findByType(root, 'TextInput').some(
        el => (el.props as { value?: unknown }).value === 'patch failed'
      )
    ).toBe(false);
  });
});
