/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); same pattern as tool-diff-preview.test.ts */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { describe, expect, it, vi } from 'vitest';

import { CodeBlock } from './code-block';
import { tokenizeCodeLines } from './code-block-model';
import { type MonoScrollTextMode } from './mono-scroll-block-model';
import { tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';
import '@/i18n';

const { useMonoScrollSheetMock } = vi.hoisted(() => ({
  useMonoScrollSheetMock: vi.fn<() => { mode: MonoScrollTextMode; track: () => () => void } | null>(
    () => null
  ),
}));

// RNGH ships Flow source that the node project cannot parse, so the horizontal
// ScrollView becomes a string element.
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'RNText',
}));
vi.mock('react-native-gesture-handler', () => ({
  ScrollView: 'ScrollView',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#FBFAF5',
    foreground: '#14130F',
    good: '#278150',
    destructive: '#BE4E3F',
    mutedForeground: '#6F6A61',
  }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./mono-scroll-block', () => ({
  useMonoScrollSheet: useMonoScrollSheetMock,
}));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));

type BlockProps = Parameters<typeof CodeBlock>[0];

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** True when the node is the mocked string element with the given tag name. */
function isMockedStringElement(node: TestRenderer.ReactTestInstance, name: string): boolean {
  return typeof node.type === 'string' && node.type === name;
}

/** Nested RNText token runs: the ones that carry a style.color. */
function colorRuns(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => {
    const style = propOf(node, 'style') as { color?: string } | undefined;
    return typeof style?.color === 'string';
  });
}

/** The single parent code RNText (carries the mono sizing className). */
function codeParent(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance | undefined {
  return root.findAll(node => {
    if (!isMockedStringElement(node, 'RNText')) {
      return false;
    }
    const className = propOf(node, 'className');
    return typeof className === 'string' && className.includes('font-mono text-xs');
  })[0];
}

function truncatedMarkers(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      propOf(node, 'accessibilityLabel') === 'Content truncated'
  );
}

async function mount(element: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(element);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.unmount();
  });
}

function blockElement(props?: Partial<BlockProps>): React.ReactElement {
  return React.createElement(CodeBlock, { code: 'const x = 1;', language: 'typescript', ...props });
}

function withSheet(
  mode: MonoScrollTextMode,
  track: () => () => void,
  block: React.ReactElement
): React.ReactElement {
  useMonoScrollSheetMock.mockReturnValue({ mode, track });
  return block;
}

describe('CodeBlock', () => {
  it('renders one nested RNText per token run', async () => {
    const renderer = await mount(blockElement());
    const expectedRuns = tokenizeCodeLines('const x = 1;', 'typescript').reduce(
      (total, line) => total + line.length,
      0
    );
    expect(expectedRuns).toBeGreaterThan(0);
    expect(colorRuns(renderer.root)).toHaveLength(expectedRuns);
    await unmount(renderer);
  });

  it('applies tokenColorFor to tagged runs and baseColor to plain runs', async () => {
    const baseColor = '#112233';
    const renderer = await mount(blockElement({ baseColor }));

    const runColors = colorRuns(renderer.root).map(
      run => (propOf(run, 'style') as { color: string }).color
    );
    expect(runColors).toContain(tokenColorFor('keyword', false));
    expect(runColors).toContain(tokenColorFor('number', false));
    expect(runColors).toContain(baseColor);

    const keywordRun = colorRuns(renderer.root).find(
      run => (propOf(run, 'style') as { color: string }).color === tokenColorFor('keyword', false)
    );
    if (!keywordRun) {
      throw new Error('expected a keyword-colored run');
    }
    expect(propOf(keywordRun, 'children')).toBe('const');
    await unmount(renderer);
  });

  it('uses the theme foreground for plain runs by default', async () => {
    const renderer = await mount(blockElement());
    const runColors = colorRuns(renderer.root).map(
      run => (propOf(run, 'style') as { color: string }).color
    );
    expect(runColors).toContain('#14130F');
    await unmount(renderer);
  });

  it('shows the Truncated marker when the cap is hit', async () => {
    const renderer = await mount(blockElement({ code: 'x'.repeat(300), maxLength: 50 }));
    expect(truncatedMarkers(renderer.root)).toHaveLength(1);
    await unmount(renderer);
  });

  it('does not show the Truncated marker under the cap', async () => {
    const renderer = await mount(blockElement({ code: 'short', maxLength: 500 }));
    expect(truncatedMarkers(renderer.root)).toHaveLength(0);
    await unmount(renderer);
  });

  it('wraps without a ScrollView outside the sheet and in wrap mode', async () => {
    const track = vi.fn(() => () => undefined);
    const renderer = await mount(withSheet('wrap', track, blockElement()));
    expect(renderer.root.findAll(node => isMockedStringElement(node, 'ScrollView'))).toHaveLength(
      0
    );
    await unmount(renderer);
  });

  it('mounts the RNGH ScrollView in sheet scroll mode', async () => {
    const track = vi.fn(() => () => undefined);
    const renderer = await mount(withSheet('scroll', track, blockElement()));
    const scrollViews = renderer.root.findAll(node => isMockedStringElement(node, 'ScrollView'));
    expect(scrollViews).toHaveLength(1);
    const parent = codeParent(renderer.root);
    expect(parent).toBeDefined();
    expect((propOf(parent, 'className') as string).includes('shrink-0 self-start')).toBe(true);
    await unmount(renderer);
  });

  it('registers presence once on mount', async () => {
    const unregister = vi.fn();
    const track = vi.fn(() => unregister);
    const renderer = await mount(withSheet('wrap', track, blockElement()));
    expect(track).toHaveBeenCalledTimes(1);
    await unmount(renderer);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('defaults selectable to the transcript-selection context', async () => {
    const renderer = await mount(blockElement());
    const parent = codeParent(renderer.root);
    expect(parent).toBeDefined();
    expect(propOf(parent, 'selectable')).toBe(true);
    await unmount(renderer);
  });

  it('honors an explicit selectable prop over the context default', async () => {
    const renderer = await mount(blockElement({ selectable: false }));
    const parent = codeParent(renderer.root);
    expect(parent).toBeDefined();
    expect(propOf(parent, 'selectable')).toBe(false);
    await unmount(renderer);
  });
});
