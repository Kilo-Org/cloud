import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ToolDiffModel } from '../tool-diff-model';
import { EditToolCard } from './edit-tool-card';
import * as React from 'react';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('lucide-react-native', () => ({ Pencil: 'Pencil' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('../bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('../mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
vi.mock('../tool-card-shell', () => ({ ToolCardShell: 'ToolCardShell' }));
vi.mock('../tool-card-utils', () => ({
  getFilename: (p: string) => p.split('/').pop() ?? p,
}));
vi.mock('../tool-diff-preview', () => ({ ToolDiffPreview: 'ToolDiffPreview' }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>();
  return {
    default: actual,
    ...actual,
    useMemo: <T>(fn: () => T): T => fn(),
  };
});

const { buildToolDiffModel } = vi.hoisted(() => ({
  buildToolDiffModel: vi.fn(),
}));
vi.mock('../tool-diff-model', () => ({ buildToolDiffModel }));

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

describe('EditToolCard — diff preview routing', () => {
  beforeEach(() => {
    buildToolDiffModel.mockReset();
  });

  it('renders ToolDiffPreview when the model exists', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCard({ part: makeEditPart({}) }) as unknown as React.ReactElement;
    const previews = findByType(root, 'ToolDiffPreview');
    expect(previews).toHaveLength(1);
  });

  it('passes the model and partId to ToolDiffPreview', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCard({ part: makeEditPart({}) }) as unknown as React.ReactElement;
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
    const root = EditToolCard({
      part: makeEditPart({ oldString: 'old', newString: 'new' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(2);
  });

  it('renders no body when the model does not exist and strings are empty', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCard({
      part: makeEditPart({ oldString: '', newString: '' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
  });

  it('preserves the error block when the model exists', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCard({
      part: makeEditPart({ status: 'error', error: 'something went wrong' }),
    }) as unknown as React.ReactElement;
    const texts = findAll(
      root,
      el =>
        el.type === 'Text' &&
        (el.props as { children?: string }).children === 'something went wrong'
    );
    expect(texts).toHaveLength(1);
  });

  it('preserves the error block when the model does not exist', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = EditToolCard({
      part: makeEditPart({
        oldString: 'old',
        newString: 'new',
        status: 'error',
        error: 'edit failed',
      }),
    }) as unknown as React.ReactElement;
    const texts = findAll(
      root,
      el => el.type === 'Text' && (el.props as { children?: string }).children === 'edit failed'
    );
    expect(texts).toHaveLength(1);
  });
});
