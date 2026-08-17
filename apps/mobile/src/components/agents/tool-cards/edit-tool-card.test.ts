import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ToolDiffModel } from '../tool-diff-model';
import { EditToolCard, EditToolCardBody } from './edit-tool-card';
import * as React from 'react';

vi.mock('react-native', () => ({ View: 'View', TextInput: 'TextInput' }));
vi.mock('@/components/ui/icons', () => ({ Pencil: 'Pencil' }));
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
vi.mock('../tool-diff-preview', () => ({ ToolDiffPreview: 'ToolDiffPreview' }));
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

const { buildToolDiffModel } = vi.hoisted(() => ({
  buildToolDiffModel: vi.fn(),
}));
vi.mock('../tool-diff-model', () => ({ buildToolDiffModel }));

const { getToolDisplay, toolPartHasDetails, openSpy } = vi.hoisted(() => ({
  getToolDisplay: vi.fn(),
  toolPartHasDetails: vi.fn(),
  openSpy: vi.fn(),
}));
vi.mock('../tool-card-display', () => ({ getToolDisplay, toolPartHasDetails }));
vi.mock('../open-part-detail-context', () => ({ useOpenPartDetail: () => openSpy }));

function makeCompletedState(overrides: {
  filePath: string;
  oldString: string;
  newString: string;
}): Extract<ToolPart['state'], { status: 'completed' }> {
  return {
    status: 'completed',
    input: {
      filePath: overrides.filePath,
      oldString: overrides.oldString,
      newString: overrides.newString,
    },
    output: '',
    title: 'edit',
    metadata: {},
    time: { start: 0, end: 1 },
  };
}

function makeErrorState(overrides: {
  filePath: string;
  oldString: string;
  newString: string;
  error: string;
}): Extract<ToolPart['state'], { status: 'error' }> {
  return {
    status: 'error',
    input: {
      filePath: overrides.filePath,
      oldString: overrides.oldString,
      newString: overrides.newString,
    },
    error: overrides.error,
    time: { start: 0, end: 1 },
  };
}

function makeEditPart(overrides: {
  oldString?: string;
  newString?: string;
  filePath?: string;
  status?: string;
  error?: string;
}): ToolPart {
  const filePath = overrides.filePath ?? 'src/app.tsx';
  const oldString = overrides.oldString ?? 'old';
  const newString = overrides.newString ?? 'new';

  const state: ToolPart['state'] =
    overrides.status === 'error'
      ? makeErrorState({
          filePath,
          oldString,
          newString,
          error: overrides.error ?? 'failed',
        })
      : makeCompletedState({ filePath, oldString, newString });

  return {
    id: 'edit-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'edit',
    state,
  };
}

function makeModel(): ToolDiffModel {
  return {
    lines: [
      { type: 'del', oldLine: 1, text: 'old', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 1, text: 'new', noNewlineAtEndOfFile: false },
    ],
    filePath: 'src/app.tsx',
    language: 'typescript',
    truncated: false,
    tool: 'edit',
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

describe('EditToolCard — fixed row', () => {
  beforeEach(() => {
    buildToolDiffModel.mockReset();
    getToolDisplay.mockReset();
    toolPartHasDetails.mockReset();
    openSpy.mockReset();
  });

  it('renders a FixedPartRow with the display projection and status', () => {
    getToolDisplay.mockReturnValue({ title: 'edit', subtitle: 'app.tsx' });
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCard({ part: makeEditPart({}) }) as unknown as React.ReactElement;
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
      icon: 'Pencil',
      label: 'app.tsx',
      status: 'completed',
      accessibilityLabel: 'app.tsx tool, completed',
    });
    expect(rowProps.badge).toBeUndefined();
  });

  it('wires onPress to openPartDetail with the part id when details exist', () => {
    getToolDisplay.mockReturnValue({ title: 'edit', subtitle: 'app.tsx' });
    toolPartHasDetails.mockReturnValue(true);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCard({ part: makeEditPart({}) }) as unknown as React.ReactElement;
    const row = findByType(root, 'FixedPartRow')[0];
    if (!row) {
      throw new Error('row not found');
    }
    const onPress = (row.props as { onPress?: unknown }).onPress as () => void;
    expect(onPress).toBeTypeOf('function');
    onPress();
    expect(openSpy).toHaveBeenCalledWith('edit-1');
  });

  it('leaves onPress undefined when details do not exist', () => {
    getToolDisplay.mockReturnValue({ title: 'edit', subtitle: 'app.tsx' });
    toolPartHasDetails.mockReturnValue(false);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCard({ part: makeEditPart({}) }) as unknown as React.ReactElement;
    const row = findByType(root, 'FixedPartRow')[0];
    if (!row) {
      throw new Error('row not found');
    }
    expect((row.props as { onPress?: unknown }).onPress).toBeUndefined();
  });
});

describe('EditToolCardBody — diff preview routing', () => {
  beforeEach(() => {
    buildToolDiffModel.mockReset();
  });

  it('renders ToolDiffPreview when the model exists', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCardBody({ part: makeEditPart({}) }) as unknown as React.ReactElement;
    const previews = findByType(root, 'ToolDiffPreview');
    expect(previews).toHaveLength(1);
  });

  it('passes the model and partId to ToolDiffPreview', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCardBody({ part: makeEditPart({}) }) as unknown as React.ReactElement;
    const preview = findByType(root, 'ToolDiffPreview')[0];
    expect(preview).toBeDefined();
    if (!preview) {
      throw new Error('preview not found');
    }
    expect((preview.props as { model: unknown }).model).toBe(model);
    expect((preview.props as { partId: unknown }).partId).toBe('edit-1');
  });

  it('renders MonoScrollBlock fallback when the model does not exist', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCardBody({
      part: makeEditPart({ oldString: 'old', newString: 'new' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
    const blocks = findByType(root, 'MonoScrollBlock');
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect((block.props as { maxLength?: unknown }).maxLength).toBeUndefined();
    }
  });

  it('renders no body when the model does not exist and strings are empty', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCardBody({
      part: makeEditPart({ oldString: '', newString: '' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
  });

  it('preserves the error block when the model exists', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCardBody({
      part: makeEditPart({ status: 'error', error: 'something went wrong' }),
    }) as unknown as React.ReactElement;
    const texts = findAll(
      root,
      el =>
        el.type === 'TextInput' && (el.props as { value?: string }).value === 'something went wrong'
    );
    expect(texts).toHaveLength(1);
  });

  it('preserves the error block when the model does not exist', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCardBody({
      part: makeEditPart({
        oldString: 'old',
        newString: 'new',
        status: 'error',
        error: 'edit failed',
      }),
    }) as unknown as React.ReactElement;
    const texts = findAll(
      root,
      el => el.type === 'TextInput' && (el.props as { value?: string }).value === 'edit failed'
    );
    expect(texts).toHaveLength(1);
  });
});
