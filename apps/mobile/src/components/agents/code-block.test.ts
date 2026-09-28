/* eslint-disable max-lines -- token-color, truncation, and copy/long-press suites share the direct-invocation CodeBlock harness. */
import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeBlock } from './code-block';
import {
  chunkTokenLines,
  CODE_CHUNK_MOUNT_BATCH,
  CODE_CHUNK_TOKENS,
  CODE_FIRST_PAINT_CHUNKS,
  tokenizeCodeLines,
} from './code-block-model';
import { type MonoScrollTextMode } from './mono-scroll-block-model';
import { tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';
import '@/i18n';

const { useMonoScrollSheetMock, useColorSchemeMock } = vi.hoisted(() => ({
  useMonoScrollSheetMock: vi.fn<() => { mode: MonoScrollTextMode; track: () => () => void } | null>(
    () => null
  ),
  useColorSchemeMock: vi.fn<() => 'dark' | 'light'>(() => 'light'),
}));

// RNGH ships Flow source that the node project cannot parse, so the horizontal
// ScrollView becomes a string element.
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Text: 'RNText',
  useColorScheme: useColorSchemeMock,
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
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** True when the node is the mocked string element with the given tag name. */
function isMockedStringElement(node: TestRenderer.ReactTestInstance, name: string): boolean {
  return typeof node.type === 'string' && node.type === name;
}

/** Code Texts carrying the mono sizing: the selectable fence, or one per chunk. */
function codeLines(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => {
    if (!isMockedStringElement(node, 'RNText')) {
      return false;
    }
    const className = propOf(node, 'className');
    return typeof className === 'string' && className.includes('font-mono text-xs');
  });
}

/** The first code Text (the fence, or the first chunk of a chunked fence). */
function codeParent(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance | undefined {
  return codeLines(root)[0];
}

/** Source lines held by one non-selectable code Text: one `Fragment` per line. */
function chunkLineCount(chunk: TestRenderer.ReactTestInstance): number {
  const children = propOf(chunk, 'children');
  return Array.isArray(children) ? children.length : 0;
}

/** Every string in a node's rendered children, depth first. */
function renderedStrings(node: unknown): string[] {
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => renderedStrings(item));
  }
  if (node && typeof node === 'object' && 'props' in node) {
    return renderedStrings((node as { props: { children?: unknown } }).props.children);
  }
  return [];
}

/** The intrinsic-width content wrapper of the sheet scroll mode. */
function codeScrollContent(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance | undefined {
  return root.findAll(node => {
    if (!isMockedStringElement(node, 'View')) {
      return false;
    }
    const className = propOf(node, 'className');
    return typeof className === 'string' && className.includes('shrink-0 self-start');
  })[0];
}

/** Nested RNText token runs: the colored runs, never the code chunk Texts. */
function colorRuns(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => {
    if (propOf(node, 'className') !== undefined) {
      return false;
    }
    const style = propOf(node, 'style') as { color?: string } | undefined;
    return typeof style?.color === 'string';
  });
}

/**
 * The fence's accessibility host: the single element that carries the code and
 * the `copyCode` action. `Text` is one element per chunk on iOS, so the
 * non-selectable path wraps its chunks in one accessible `View`.
 */
function accessibilityHosts(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => propOf(node, 'accessible') === true);
}

function truncatedMarkers(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      propOf(node, 'accessibilityLabel') === 'Content truncated'
  );
}

function byTestId(
  root: TestRenderer.ReactTestInstance,
  testID: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => propOf(node, 'testID') === testID);
}

function firstByTestId(
  root: TestRenderer.ReactTestInstance,
  testID: string
): TestRenderer.ReactTestInstance {
  const first = byTestId(root, testID)[0];
  if (!first) {
    throw new TypeError(`expected a node with testID ${testID}`);
  }
  return first;
}

function press(instance: TestRenderer.ReactTestInstance): void {
  const onPress = propOf(instance, 'onPress');
  if (typeof onPress !== 'function') {
    throw new TypeError('expected an onPress handler');
  }
  (onPress as () => void)();
}

function longPress(instance: TestRenderer.ReactTestInstance): void {
  const onLongPress = propOf(instance, 'onLongPress');
  if (typeof onLongPress !== 'function') {
    throw new TypeError('expected an onLongPress handler');
  }
  (onLongPress as () => void)();
}

function layout(instance: TestRenderer.ReactTestInstance, width: number, height: number): void {
  const onLayout = propOf(instance, 'onLayout');
  if (typeof onLayout !== 'function') {
    throw new TypeError('expected an onLayout handler');
  }
  (
    onLayout as (event: {
      nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
    }) => void
  )({
    nativeEvent: { layout: { x: 0, y: 0, width, height } },
  });
}

function pressables(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => isMockedStringElement(node, 'Pressable'));
}

/** The source lines a fence of `code` needs at one chunk per `Text`. */
function expectedChunkCount(code: string, language: string | null): number {
  return chunkTokenLines(tokenizeCodeLines(code, language)).length;
}

/**
 * Let the fence's bounded mount batches land. The block mounts
 * `CODE_FIRST_PAINT_CHUNKS` chunks in its first render and adds one batch per
 * `setTimeout(0)` tick, so a test that needs the whole fence waits for the
 * chunk count to stop growing.
 */
async function settleChunkMounts(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  let mounted = 0;
  for (let tick = 0; tick < 500; tick += 1) {
    const current = codeLines(renderer.root).length;
    if (current === mounted) {
      return;
    }
    mounted = current;
    // eslint-disable-next-line no-await-in-loop -- one tick per bounded mount batch, in order
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
  }
  throw new Error('the fence never finished mounting its chunks');
}

/** The fence's chunk mount counts after each batch, starting with the first paint. */
async function chunkMountHistory(
  renderer: TestRenderer.ReactTestRenderer,
  totalChunks: number
): Promise<number[]> {
  const history = [codeLines(renderer.root).length];
  while ((history.at(-1) ?? 0) < totalChunks) {
    // eslint-disable-next-line no-await-in-loop -- one tick per bounded mount batch, in order
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    history.push(codeLines(renderer.root).length);
  }
  return history;
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

/**
 * Mount without letting the batch timers run: the synchronous act flushes the
 * mount effects but leaves a `setTimeout(0)` batch pending, so the caller sees
 * the fence's first commit.
 */
function mountFirstCommit(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(element);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/**
 * Update without letting the batch timers run: the synchronous act flushes the
 * update's effects but leaves a `setTimeout(0)` batch pending, so the caller
 * sees the fence's first commit after the update (see `mountFirstCommit`).
 * Asserting the first commit through an async act is a race — the batch can
 * land inside that act, and the fence legitimately mounts more than one batch.
 */
function updateFirstCommit(
  renderer: TestRenderer.ReactTestRenderer,
  element: React.ReactElement
): void {
  act(() => {
    renderer.update(element);
  });
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

/** The style.color of every colored run, in render order. */
function runColorValues(root: TestRenderer.ReactTestInstance): string[] {
  return colorRuns(root).map(run => (propOf(run, 'style') as { color: string }).color);
}

function withSheet(
  mode: MonoScrollTextMode,
  track: () => () => void,
  block: React.ReactElement
): React.ReactElement {
  useMonoScrollSheetMock.mockReturnValue({ mode, track });
  return block;
}

// The light palette is the baseline for the suites that assert concrete token
// colors; the theme suite overrides it per test.
beforeEach(() => {
  useColorSchemeMock.mockReturnValue('light');
});

describe('CodeBlock', () => {
  it('renders a short non-selectable fence as one code Text', async () => {
    const renderer = await mount(blockElement({ selectable: false }));
    expect(codeLines(renderer.root)).toHaveLength(1);

    const expectedRuns = tokenizeCodeLines('const x = 1;', 'typescript').reduce(
      (total, line) => total + line.filter(token => token.className !== null).length,
      0
    );
    expect(expectedRuns).toBeGreaterThan(0);
    expect(colorRuns(renderer.root)).toHaveLength(expectedRuns);
    await unmount(renderer);
  });

  it('chunks a selectable fence, so no Text holds the whole file', async () => {
    // Regression: Android selects inside one `ReactTextView` only, but a
    // whole-fence Text made a selectable fence ONE `SpannableStringBuilder` for
    // the file the tool detail sheet routes through it (read-tool-card.tsx caps
    // that at 50,000 characters). Its spans — thousands of
    // `SetSpanOperation.execute` calls — landed in the frame that opened the
    // sheet, which stayed on its bare backdrop until they finished. A selectable
    // fence chunks like every other fence; a press-hold-drag still selects
    // across lines in one gesture because it selects inside the chunk it starts
    // in (32 lines).
    const code = Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`).join(
      '\n'
    );
    const renderer = await mount(blockElement({ code, language: 'typescript' }));

    const chunks = codeLines(renderer.root);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(200);
    for (const chunk of chunks) {
      expect(propOf(chunk, 'selectable')).toBe(true);
    }
    await settleChunkMounts(renderer);
    expect(codeLines(renderer.root)).toHaveLength(expectedChunkCount(code, 'typescript'));

    // Nothing is dropped by the split: the tagged runs of every line still
    // total what the highlighter produced.
    const expectedRuns = tokenizeCodeLines(code, 'typescript').reduce(
      (total, line) => total + line.filter(token => token.className !== null).length,
      0
    );
    expect(expectedRuns).toBeGreaterThan(0);
    expect(colorRuns(renderer.root)).toHaveLength(expectedRuns);
    await unmount(renderer);
  });

  it('mounts a bounded first paint, then the rest of the fence in batches', async () => {
    // Regression: the chunk cap bounds the spans one Text holds, but RN applies
    // every mounted Text's spans in the frame that mounts it, so mounting a
    // 1,500-line read body at once still held the sheet on its backdrop. The
    // first render mounts a bounded front of the fence; later commits add
    // bounded batches, so no single frame carries the whole file.
    const code = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`).join(
      '\n'
    );
    const total = expectedChunkCount(code, 'typescript');
    expect(total).toBeGreaterThan(CODE_FIRST_PAINT_CHUNKS + CODE_CHUNK_MOUNT_BATCH);
    const renderer = mountFirstCommit(blockElement({ code, language: 'typescript' }));

    // The first commit paints the front of the fence and no more.
    expect(codeLines(renderer.root)).toHaveLength(CODE_FIRST_PAINT_CHUNKS);

    const history = await chunkMountHistory(renderer, total);
    expect(history.at(-1)).toBe(total);
    // Every commit after the first adds at most one bounded batch.
    for (const [index, mounted] of history.entries()) {
      const previous = index === 0 ? 0 : (history[index - 1] ?? 0);
      expect(mounted - previous).toBeLessThanOrEqual(CODE_CHUNK_MOUNT_BATCH);
    }
    await unmount(renderer);
  });

  it('starts a changed fence at the bounded first paint, not the last mount count', async () => {
    const longCode = Array.from(
      { length: 400 },
      (_, index) => `const value${index} = ${index};`
    ).join('\n');
    const renderer = await mount(blockElement({ code: longCode, language: 'typescript' }));
    await settleChunkMounts(renderer);
    expect(codeLines(renderer.root).length).toBeGreaterThan(CODE_FIRST_PAINT_CHUNKS);

    const otherCode = Array.from(
      { length: 400 },
      (_, index) => `let other${index} = ${index};`
    ).join('\n');
    updateFirstCommit(renderer, blockElement({ code: otherCode, language: 'typescript' }));
    expect(codeLines(renderer.root)).toHaveLength(CODE_FIRST_PAINT_CHUNKS);
    await unmount(renderer);
  });

  it('does not resume a replaced fence’s mount count in a later fence that extends it', async () => {
    // Regression: a replaced fence shorter than the first paint never ran the
    // batch effect, so the mount state kept the replaced-away text and count.
    // A later fence that extends that text matched it and mounted more than one
    // bounded batch in its first commit.
    const longCode = Array.from(
      { length: 400 },
      (_, index) => `const value${index} = ${index};`
    ).join('\n');
    const renderer = await mount(blockElement({ code: longCode, language: 'typescript' }));
    await settleChunkMounts(renderer);
    expect(codeLines(renderer.root).length).toBeGreaterThan(CODE_FIRST_PAINT_CHUNKS);

    updateFirstCommit(renderer, blockElement({ code: 'short', language: 'typescript' }));
    expect(codeLines(renderer.root)).toHaveLength(1);

    updateFirstCommit(
      renderer,
      blockElement({ code: `${longCode}\nconst appended = true;`, language: 'typescript' })
    );
    expect(codeLines(renderer.root)).toHaveLength(CODE_FIRST_PAINT_CHUNKS);
    await unmount(renderer);
  });

  it('splits one run-dense source line across chunk Texts', async () => {
    // Regression: chunking by lines alone left a single long source line in one
    // `Text` with its whole token run set applied in one frame. The tool sheet
    // routes a read body of up to 50,000 characters through this block, and a
    // minified file is exactly one such line.
    const code = JSON.stringify({
      items: Array.from({ length: 100 }, (_, index) => ({ id: index, name: `name-${index}` })),
    });
    expect(code.split('\n')).toHaveLength(1);
    const totalRuns = tokenizeCodeLines(code, 'json')[0]?.filter(
      token => token.className !== null
    ).length;
    expect(totalRuns).toBeGreaterThan(CODE_CHUNK_TOKENS);

    const renderer = await mount(blockElement({ code, language: 'json', selectable: false }));
    await settleChunkMounts(renderer);
    const chunks = codeLines(renderer.root);
    expect(chunks).toHaveLength(expectedChunkCount(code, 'json'));
    expect(chunks.length).toBeGreaterThan(1);

    // No chunk Text holds more than the run budget, and the split drops none of
    // the line's tagged runs.
    let renderedRuns = 0;
    for (const chunk of chunks) {
      const runs = colorRuns(chunk).length;
      expect(runs).toBeLessThanOrEqual(CODE_CHUNK_TOKENS);
      renderedRuns += runs;
    }
    expect(renderedRuns).toBe(totalRuns);
    await unmount(renderer);
  });

  it('keeps a streamed fence mounted when its code only grows', async () => {
    // Regression: resetting the mount count on every text change dropped and
    // re-applied the whole fence's spans on each streamed token, which is the
    // per-frame work the bounded first paint exists to avoid. A fence that only
    // appends (the transcript streaming a code block) keeps its mounts.
    const code = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`).join(
      '\n'
    );
    const renderer = await mount(blockElement({ code, language: 'typescript' }));
    await settleChunkMounts(renderer);
    const mounted = codeLines(renderer.root).length;
    expect(mounted).toBeGreaterThan(CODE_FIRST_PAINT_CHUNKS);

    const grown = `${code}\nconst appended = true;`;
    await act(async () => {
      await Promise.resolve();
      renderer.update(blockElement({ code: grown, language: 'typescript' }));
    });
    expect(codeLines(renderer.root).length).toBeGreaterThanOrEqual(mounted);
    await unmount(renderer);
  });

  it('costs no token span for an untagged run in a selectable fence', async () => {
    const code = Array.from({ length: 20 }, (_, index) => `plain output line ${index}`).join('\n');
    const renderer = await mount(blockElement({ code, language: null }));
    expect(codeLines(renderer.root)).toHaveLength(1);
    expect(colorRuns(renderer.root)).toHaveLength(0);
    await unmount(renderer);
  });

  it('keeps a blank source line as its own node in a selectable fence', async () => {
    const renderer = await mount(blockElement({ code: 'a\n\nb', language: null }));
    const [fence] = codeLines(renderer.root);
    expect(fence).toBeDefined();
    expect(propOf(fence, 'children')).toHaveLength(3);
    await unmount(renderer);
  });

  it('bounds a non-selectable fence to a run of lines per Text, not a Text per line', async () => {
    // Regression: the fence used to render all lines into one RNText, so a
    // long file produced one SpannableStringBuilder whose span count scaled
    // with the whole file (the Android `SetSpanOperation.execute` ANR). One
    // Text per line moved the same scale onto the native view count, so the
    // fence renders a chunk of lines per Text instead: no Text holds the whole
    // fence, and the views a fence needs stay far below its line count.
    const code = Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`).join(
      '\n'
    );
    const renderer = await mount(blockElement({ code, language: 'typescript', selectable: false }));
    await settleChunkMounts(renderer);

    const chunks = codeLines(renderer.root);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(200);

    // Every chunk but the last holds the same number of lines; the last holds
    // the remainder. That is what bounds both the views and a Text's spans.
    const linesPerChunk = chunks.map(chunk => chunkLineCount(chunk));
    expect(linesPerChunk.reduce((total, lines) => total + lines, 0)).toBe(200);
    expect(Math.max(...linesPerChunk)).toBeLessThan(200);
    expect(linesPerChunk.slice(0, -1).every(lines => lines === linesPerChunk[0])).toBe(true);
    expect(linesPerChunk.at(-1)).toBeLessThanOrEqual(linesPerChunk[0] ?? 0);

    // The tagged runs of the whole fence still total what the highlighter
    // produced — nothing is dropped by the split.
    const expectedRuns = tokenizeCodeLines(code, 'typescript').reduce(
      (total, line) => total + line.filter(token => token.className !== null).length,
      0
    );
    expect(colorRuns(renderer.root)).toHaveLength(expectedRuns);
    await unmount(renderer);
  });

  it('costs no token span for an untagged run', async () => {
    // A fence with no language highlights to plain text; every line is one
    // raw string, so no code Text carries a nested token Text at all.
    const code = Array.from({ length: 100 }, (_, index) => `plain output line ${index}`).join('\n');
    const renderer = await mount(blockElement({ code, language: null, selectable: false }));
    const chunks = codeLines(renderer.root);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(100);
    expect(colorRuns(renderer.root)).toHaveLength(0);
    await unmount(renderer);
  });

  it('renders no blank code line for an empty fence', async () => {
    // Regression: the blank-line placeholder keeps the box of a blank line
    // that sits among other lines. An empty fence has no other line, so it
    // keeps the zero-height empty code Text the whole-fence RNText rendered
    // instead of gaining a blank code line.
    const renderer = await mount(blockElement({ code: '', language: 'typescript' }));
    const [fence] = codeLines(renderer.root);
    expect(fence).toBeDefined();
    expect(renderedStrings(propOf(fence, 'children'))).not.toContain(' ');
    await unmount(renderer);
  });

  it('keeps a blank source line as a line box in a chunk', async () => {
    const renderer = await mount(
      blockElement({ code: 'a\n\nb', language: null, selectable: false })
    );
    const [chunk] = codeLines(renderer.root);
    expect(chunk).toBeDefined();
    // One Fragment per source line: a break before every line but the chunk's
    // first, and a space (never an empty child) for the blank line, so its box
    // survives wherever it falls in the chunk.
    const lineChildren = propOf(chunk, 'children') as { props: { children: unknown[] } }[];
    expect(lineChildren).toHaveLength(3);
    expect(lineChildren[1]?.props.children).toEqual(['\n', ' ']);
    await unmount(renderer);
  });

  it('applies tokenColorFor to tagged runs and baseColor to the line text', async () => {
    const baseColor = '#112233';
    const renderer = await mount(blockElement({ baseColor }));

    const runColors = colorRuns(renderer.root).map(
      run => (propOf(run, 'style') as { color: string }).color
    );
    expect(runColors).toContain(tokenColorFor('keyword', false));
    expect(runColors).toContain(tokenColorFor('number', false));
    // Untagged runs are plain strings inside the line Text, so the base ink
    // moves from a per-token run onto the line itself.
    expect((propOf(codeParent(renderer.root), 'style') as { color: string }).color).toBe(baseColor);

    const keywordRun = colorRuns(renderer.root).find(
      run => (propOf(run, 'style') as { color: string }).color === tokenColorFor('keyword', false)
    );
    if (!keywordRun) {
      throw new Error('expected a keyword-colored run');
    }
    expect(propOf(keywordRun, 'children')).toBe('const');
    await unmount(renderer);
  });

  it('uses the theme foreground for the line text by default', async () => {
    const renderer = await mount(blockElement());
    expect((propOf(codeParent(renderer.root), 'style') as { color: string }).color).toBe('#14130F');
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
    const content = codeScrollContent(renderer.root);
    expect(content).toBeDefined();
    expect(codeLines(renderer.root).length).toBeGreaterThan(0);
    // Each code line keeps the mono sizing inside the intrinsic-width wrapper.
    const [firstLine] = codeLines(renderer.root);
    expect((propOf(firstLine, 'className') as string).includes('font-mono text-xs')).toBe(true);
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

describe('CodeBlock syntax palette follows the color scheme', () => {
  // The palette must come from the color scheme, not from comparing a theme
  // token (e.g. `background`) to a hex literal: the generated palette is free
  // to change and the tokens would silently flip against their surface.
  it('picks the dark token palette on a dark color scheme', async () => {
    useColorSchemeMock.mockReturnValue('dark');
    const renderer = await mount(blockElement());
    const colors = runColorValues(renderer.root);

    expect(colors).toContain(tokenColorFor('keyword', true));
    expect(colors).toContain(tokenColorFor('number', true));
    expect(colors).not.toContain(tokenColorFor('keyword', false));
    await unmount(renderer);
  });

  it('picks the light token palette on a light color scheme', async () => {
    useColorSchemeMock.mockReturnValue('light');
    const renderer = await mount(blockElement());
    const colors = runColorValues(renderer.root);

    expect(colors).toContain(tokenColorFor('keyword', false));
    expect(colors).toContain(tokenColorFor('number', false));
    expect(colors).not.toContain(tokenColorFor('keyword', true));
    await unmount(renderer);
  });

  it('reads the scheme again on a later render instead of caching the palette', async () => {
    useColorSchemeMock.mockReturnValue('light');
    const renderer = await mount(blockElement());
    expect(runColorValues(renderer.root)).toContain(tokenColorFor('keyword', false));

    useColorSchemeMock.mockReturnValue('dark');
    act(() => {
      renderer.update(blockElement({ code: 'let y = 2;' }));
    });

    expect(runColorValues(renderer.root)).toContain(tokenColorFor('keyword', true));
    await unmount(renderer);
  });
});

describe('CodeBlock copy action', () => {
  it('renders no copy affordance without an onCopyCode handler', async () => {
    const renderer = await mount(blockElement());
    expect(byTestId(renderer.root, 'code-block-copy-trigger')).toHaveLength(0);
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(0);
    await unmount(renderer);
  });

  it('reveals the copy action on a single tap and hands back the full source', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ code: 'const x = 1;', onCopyCode }));

    expect(byTestId(renderer.root, 'code-block-copy-trigger')).toHaveLength(1);
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(0);

    act(() => {
      press(firstByTestId(renderer.root, 'code-block-copy-trigger'));
    });
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(1);

    act(() => {
      press(firstByTestId(renderer.root, 'code-block-copy-action'));
    });
    expect(onCopyCode).toHaveBeenCalledWith('const x = 1;');
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(0);
    await unmount(renderer);
  });

  it('anchors the revealed action to the tap, so a tall fence shows it in view', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ code: 'x'.repeat(5000), onCopyCode }));
    const trigger = firstByTestId(renderer.root, 'code-block-copy-trigger');
    const onPress = propOf(trigger, 'onPress') as (event: {
      nativeEvent: { locationY: number };
    }) => void;

    act(() => {
      onPress({ nativeEvent: { locationY: 1234 } });
    });

    const action = firstByTestId(renderer.root, 'code-block-copy-action');
    expect(propOf(action, 'style')).toEqual({ top: 1234 });
    await unmount(renderer);
  });

  it('falls back to the block top for a synthetic press with no coordinates', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ onCopyCode }));

    act(() => {
      press(firstByTestId(renderer.root, 'code-block-copy-trigger'));
    });

    const action = firstByTestId(renderer.root, 'code-block-copy-action');
    expect(propOf(action, 'style')).toEqual({ top: 0 });
    await unmount(renderer);
  });

  it('reserves the measured action width as a right gutter on the copy trigger', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ onCopyCode }));
    const trigger = firstByTestId(renderer.root, 'code-block-copy-trigger');
    expect(propOf(trigger, 'style')).toBeUndefined();

    act(() => {
      layout(firstByTestId(renderer.root, 'code-block-copy-measure'), 96, 28);
    });

    expect(propOf(firstByTestId(renderer.root, 'code-block-copy-trigger'), 'style')).toEqual({
      paddingRight: 104,
    });
    await unmount(renderer);
  });

  it('measures the label without leaking a hidden copy button to assistive tech', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ onCopyCode }));
    const measure = firstByTestId(renderer.root, 'code-block-copy-measure');
    expect(propOf(measure, 'accessibilityElementsHidden')).toBe(true);
    expect(propOf(measure, 'importantForAccessibility')).toBe('no-hide-descendants');
    expect(propOf(measure, 'pointerEvents')).toBe('none');
    await unmount(renderer);
  });

  it('leaves the code at full width without a copy handler', async () => {
    const renderer = await mount(blockElement());
    expect(byTestId(renderer.root, 'code-block-copy-measure')).toHaveLength(0);
    expect(byTestId(renderer.root, 'code-block-copy-trigger')).toHaveLength(0);
    await unmount(renderer);
  });

  it('reserves the measured gutter on the scroll-mode trigger so the action clears the glyphs', async () => {
    const track = vi.fn(() => () => undefined);
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(withSheet('scroll', track, blockElement({ onCopyCode })));

    act(() => {
      layout(firstByTestId(renderer.root, 'code-block-copy-measure'), 72, 28);
    });

    expect(propOf(firstByTestId(renderer.root, 'code-block-copy-trigger'), 'style')).toEqual({
      paddingRight: 80,
    });
    await unmount(renderer);
  });

  it('right-aligns the revealed action inside the reserved gutter', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ onCopyCode }));

    act(() => {
      press(firstByTestId(renderer.root, 'code-block-copy-trigger'));
    });

    const action = firstByTestId(renderer.root, 'code-block-copy-action');
    expect(propOf(action, 'className')).toContain('right-0');
    await unmount(renderer);
  });

  it('copies the source before the display cap, not the truncated slice', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const full = 'x'.repeat(300);
    const renderer = await mount(blockElement({ code: full, maxLength: 50, onCopyCode }));

    act(() => {
      press(firstByTestId(renderer.root, 'code-block-copy-trigger'));
    });
    act(() => {
      press(firstByTestId(renderer.root, 'code-block-copy-action'));
    });
    expect(onCopyCode).toHaveBeenCalledWith(full);
    await unmount(renderer);
  });

  it('exposes a copy accessibility action on the fence host, selectable or not', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ onCopyCode }));
    const hosts = accessibilityHosts(renderer.root);
    expect(hosts).toHaveLength(1);
    const onAccessibilityAction = propOf(hosts[0], 'onAccessibilityAction');
    expect(typeof onAccessibilityAction).toBe('function');

    act(() => {
      (onAccessibilityAction as (event: { nativeEvent: { actionName: string } }) => void)({
        nativeEvent: { actionName: 'copyCode' },
      });
    });
    expect(onCopyCode).toHaveBeenCalledWith('const x = 1;');
    await unmount(renderer);
  });

  it('carries the copy action on one accessible host, not on every chunk Text', async () => {
    // Regression: a `Text` per line was one accessibility element per line on
    // iOS, so screen-reader navigation went from one element per fence to N.
    // The chunks stay non-accessible and the fence exposes a single host that
    // reads the code and offers the action once.
    const onCopyCode = vi.fn<(code: string) => void>();
    const code = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`).join(
      '\n'
    );
    const renderer = await mount(blockElement({ code, selectable: false, onCopyCode }));
    const chunks = codeLines(renderer.root);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(propOf(chunk, 'accessible')).toBe(false);
      expect(propOf(chunk, 'onAccessibilityAction')).toBeUndefined();
    }

    const hosts = accessibilityHosts(renderer.root);
    expect(hosts).toHaveLength(1);
    const onAccessibilityAction = propOf(hosts[0], 'onAccessibilityAction');
    expect(typeof onAccessibilityAction).toBe('function');
    act(() => {
      (onAccessibilityAction as (event: { nativeEvent: { actionName: string } }) => void)({
        nativeEvent: { actionName: 'copyCode' },
      });
    });
    expect(onCopyCode).toHaveBeenCalledWith(code);
    await unmount(renderer);
  });

  it('keeps a non-selectable fence one accessibility element without a copy handler', async () => {
    const renderer = await mount(blockElement({ selectable: false }));
    const hosts = accessibilityHosts(renderer.root);
    expect(hosts).toHaveLength(1);
    expect(propOf(hosts[0], 'accessibilityActions')).toBeUndefined();
    await unmount(renderer);
  });

  it('offers no copy action for an empty fence', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ code: '', onCopyCode }));
    expect(byTestId(renderer.root, 'code-block-copy-trigger')).toHaveLength(0);
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(0);
    await unmount(renderer);
  });

  it('hides a revealed action when the code changes', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const renderer = await mount(blockElement({ code: 'first', onCopyCode }));
    act(() => {
      press(firstByTestId(renderer.root, 'code-block-copy-trigger'));
    });
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(1);

    act(() => {
      renderer.update(blockElement({ code: 'second', onCopyCode }));
    });
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(0);
    await unmount(renderer);
  });
});

describe('CodeBlock copy trigger long-press forwarding', () => {
  it('forwards a long press on the trigger instead of revealing the action', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const onLongPressCode = vi.fn<() => void>();
    const renderer = await mount(blockElement({ onCopyCode, onLongPressCode }));
    const trigger = firstByTestId(renderer.root, 'code-block-copy-trigger');

    act(() => {
      longPress(trigger);
    });

    expect(onLongPressCode).toHaveBeenCalledTimes(1);
    expect(onCopyCode).not.toHaveBeenCalled();
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(0);
    await unmount(renderer);
  });

  it('hides a revealed action when a long press opens message details', async () => {
    const onCopyCode = vi.fn<(code: string) => void>();
    const onLongPressCode = vi.fn<() => void>();
    const renderer = await mount(blockElement({ onCopyCode, onLongPressCode }));
    const trigger = firstByTestId(renderer.root, 'code-block-copy-trigger');

    act(() => {
      press(trigger);
    });
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(1);

    act(() => {
      longPress(trigger);
    });

    expect(onLongPressCode).toHaveBeenCalledTimes(1);
    expect(byTestId(renderer.root, 'code-block-copy-action')).toHaveLength(0);
    await unmount(renderer);
  });

  it('mounts no responder wrapper without a copy handler', async () => {
    const renderer = await mount(blockElement());
    expect(pressables(renderer.root)).toHaveLength(0);
    await unmount(renderer);
  });

  it('mounts no responder wrapper without a copy handler in sheet scroll mode', async () => {
    const track = vi.fn(() => () => undefined);
    const renderer = await mount(withSheet('scroll', track, blockElement()));
    expect(pressables(renderer.root)).toHaveLength(0);
    await unmount(renderer);
  });

  it('forwards a long press on the scroll-mode trigger', async () => {
    const track = vi.fn(() => () => undefined);
    const onCopyCode = vi.fn<(code: string) => void>();
    const onLongPressCode = vi.fn<() => void>();
    const renderer = await mount(
      withSheet('scroll', track, blockElement({ onCopyCode, onLongPressCode }))
    );
    const trigger = firstByTestId(renderer.root, 'code-block-copy-trigger');

    act(() => {
      longPress(trigger);
    });

    expect(onLongPressCode).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });
});
