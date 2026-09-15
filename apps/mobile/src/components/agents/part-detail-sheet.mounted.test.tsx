/* eslint-disable max-lines -- cohesive mounted suite: mono-control presence and streaming auto-follow share one sheet harness */
import {
  type Part,
  type ReasoningPart,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import {
  createElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useImperativeHandle,
} from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Real block, imported before the sheet: the hoisted body-mock factory runs
// while the sheet module loads, so its binding must already be initialized.
import { MonoScrollBlock } from './mono-scroll-block';
import { PartDetailSheet } from './part-detail-sheet';
import { PartDetailSheetHost } from './part-detail-sheet-host';
import { useOpenPartDetail } from './open-part-detail-context';
import { setConfig } from '@/lib/tool-summary-translation/tool-summary-translation-runtime';

const { requestMock, readMock, writeMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('@/lib/tool-summary-translation/tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));
// The encrypted-KV cache is a native module, loaded by the runtime's dynamic
// import; mock it the same way as the client so this suite stays native-free.
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  readToolSummaryTranslations: readMock,
  writeToolSummaryTranslation: writeMock,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#000' }),
}));
const scrollMock = vi.hoisted(() => ({
  scrollToEnd: vi.fn<(params?: { animated?: boolean }) => void>(),
}));
vi.mock('react-native', () => ({
  Modal: 'Modal',
  ScrollView: (props: { children?: ReactNode; ref?: Ref<typeof scrollMock> }) => {
    useImperativeHandle(props.ref, () => scrollMock, []);
    return createElement('ScrollView', { ...props, ref: undefined });
  },
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('./tool-card-image-cache', () => ({ useToolCardImageUri: () => undefined }));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: 'SheetHeader',
}));
// `tool-card-display` imports the Lucide icon components; the node project cannot
// parse their Flow-sourced react-native runtime, so stub the icon module.
vi.mock('@/components/ui/icons', () => ({
  Cpu: 'Cpu',
  Eye: 'Eye',
  FileDiff: 'FileDiff',
  FilePlus: 'FilePlus',
  FileSearch: 'FileSearch',
  FolderOpen: 'FolderOpen',
  Globe: 'Globe',
  ListTodo: 'ListTodo',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Search: 'Search',
  Sparkles: 'Sparkles',
  Terminal: 'Terminal',
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/selectable-text', () => ({
  SelectableText: 'SelectableText',
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));
// RNGH ships Flow source that the node project cannot parse, so the horizontal
// ScrollView becomes a string element.
vi.mock('react-native-gesture-handler', () => ({
  ScrollView: 'ScrollView',
}));
// Content-driven body mock that mirrors the real bodies' mono content:
// BashToolCardBody renders the `$ command` line as plain text, so only a
// completed bash output block is mono (running and error bash bodies are
// mono-free); GenericToolCardBody renders the input JSON as a mono block at
// any status, plus the completed output block. Mounting a real
// MonoScrollBlock proves the full wiring: sheet state -> real SegmentedControl
// -> context provider -> real MonoScrollBlock branch. Keyed by part id so a
// part swap unmounts and remounts the block in one commit (the
// block-replacement test depends on the real effect batching).
// SegmentedControl is NOT mocked: the real control renders so its
// radiogroup/radio semantics are under test.
vi.mock('./tool-part-detail-body', () => ({
  ToolPartDetailBody: ({ part }: { part: ToolPart }) => {
    const input = part.state.input;
    const output = part.state.status === 'completed' ? part.state.output : undefined;
    const hasMono =
      part.tool === 'bash' ? Boolean(output) : Object.keys(input).length > 0 || Boolean(output);
    return hasMono ? createElement(MonoScrollBlock, { key: part.id, content: LONG_LINE }) : null;
  },
}));

/** 300+ char single-line payload, like a long tool output line. */
const LONG_LINE = `${'x'.repeat(300)} tail`;

type FixtureStatus = 'running' | 'completed' | 'error';

type BashFixtureOptions = {
  status?: FixtureStatus;
  output?: string;
};

function makeBashPart(
  id: string,
  command: string,
  { status = 'completed', output = 'done' }: BashFixtureOptions = {}
): ToolPart {
  const base = {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool' as const,
    callID: `call-${id}`,
    tool: 'bash',
  };
  if (status === 'running') {
    return { ...base, state: { status: 'running', input: { command }, time: { start: 1 } } };
  }
  if (status === 'error') {
    return {
      ...base,
      state: { status: 'error', input: { command }, error: 'boom', time: { start: 1, end: 2 } },
    };
  }
  return {
    ...base,
    state: {
      status: 'completed',
      input: { command },
      output,
      title: 'bash',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function makeGenericPart(
  id: string,
  input: Record<string, unknown>,
  status: FixtureStatus = 'completed'
): ToolPart {
  const base = {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool' as const,
    callID: `call-${id}`,
    tool: 'custom_tool',
  };
  if (status === 'running') {
    return { ...base, state: { status: 'running', input, time: { start: 1 } } };
  }
  if (status === 'error') {
    return {
      ...base,
      state: { status: 'error', input, error: 'boom', time: { start: 1, end: 2 } },
    };
  }
  return {
    ...base,
    state: {
      status: 'completed',
      input,
      output: 'done',
      title: 'custom_tool',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function makeReasoningPart(
  id: string,
  text: string,
  { streaming = false }: { streaming?: boolean } = {}
): ReasoningPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text,
    time: { start: 1, end: streaming ? undefined : 2 },
  };
}

function sheetElement(part: Part | null, visible = true): ReactElement {
  return createElement(PartDetailSheet, { visible, part, onClose: vi.fn<() => void>() });
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

function radiogroup(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance | undefined {
  return findByType(root, 'View').find(
    node =>
      propOf(node, 'accessibilityRole') === 'radiogroup' &&
      propOf(node, 'accessibilityLabel') === 'Text display'
  );
}

function radio(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance | undefined {
  return findByType(root, 'Pressable').find(
    node =>
      propOf(node, 'accessibilityRole') === 'radio' && propOf(node, 'accessibilityLabel') === label
  );
}

// A React Native radio reports its current choice through `checked`, not
// `selected` — see `radioItemA11y` in @/components/ui/radio-group.
function radioSelected(root: TestRenderer.ReactTestInstance, label: string): boolean {
  const state = propOf(radio(root, label), 'accessibilityState') as
    | { checked: boolean }
    | undefined;
  return state?.checked === true;
}

function pressRadio(root: TestRenderer.ReactTestInstance, label: string): void {
  const onPress = propOf(radio(root, label), 'onPress');
  (onPress as () => void)();
}

async function mountSheet(part: Part | null): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(sheetElement(part));
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

/**
 * Mounts the sheet with a fresh imperative ScrollView handle for each case.
 */
async function mountSheetWithScroll(element: ReactElement): Promise<{
  renderer: TestRenderer.ReactTestRenderer;
  scrollToEnd: Mock<(params?: { animated?: boolean }) => void>;
}> {
  const scrollToEnd = vi.fn<(params?: { animated?: boolean }) => void>();
  scrollMock.scrollToEnd = scrollToEnd;
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(element);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return { renderer, scrollToEnd };
}

/** The sheet's own vertical ScrollView (string element in the RN mock). */
function sheetScrollView(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const scrollView = findByType(root, 'ScrollView')[0];
  if (!scrollView) {
    throw new Error('sheet ScrollView not found');
  }
  return scrollView;
}

function scrollEvent({
  offsetY,
  contentHeight,
  viewportHeight,
}: {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
}): {
  nativeEvent: {
    contentOffset: { y: number };
    contentSize: { height: number; width: number };
    layoutMeasurement: { height: number; width: number };
  };
} {
  return {
    nativeEvent: {
      contentOffset: { y: offsetY },
      contentSize: { height: contentHeight, width: 0 },
      layoutMeasurement: { height: viewportHeight, width: 0 },
    },
  };
}

type ScrollHandler = (event: unknown) => void;
type ContentSizeHandler = (width: number, height: number) => void;

/** Fires the drag-away sequence on the sheet ScrollView, settling user-scrolling state via momentum. */
function dragAwayFromBottom(scrollView: TestRenderer.ReactTestInstance): void {
  const away = scrollEvent({ offsetY: 0, contentHeight: 1000, viewportHeight: 400 });
  (propOf(scrollView, 'onScrollBeginDrag') as () => void)();
  (propOf(scrollView, 'onScroll') as ScrollHandler)(away);
  (propOf(scrollView, 'onScrollEndDrag') as ScrollHandler)(away);
  (propOf(scrollView, 'onMomentumScrollBegin') as () => void)();
  (propOf(scrollView, 'onMomentumScrollEnd') as ScrollHandler)(away);
}

function contentSizeChange(scrollView: TestRenderer.ReactTestInstance, height: number): void {
  (propOf(scrollView, 'onContentSizeChange') as ContentSizeHandler)(0, height);
}

describe('PartDetailSheet mounted', () => {
  it('centers state-only tool details independently in main and subagent hosts', () => {
    const openers = new Map<string, ReturnType<typeof useOpenPartDetail>>();
    function CaptureOpener({ name }: { name: string }) {
      openers.set(name, useOpenPartDetail());
      return null;
    }
    const messages: StoredMessage[] = [
      {
        info: {
          id: 'm1',
          sessionID: 's1',
          role: 'user',
          time: { created: 1 },
          agent: 'test',
          model: { providerID: 'kilo', modelID: 'test' },
        },
        parts: [{ ...makeGenericPart('write-1', {}, 'error'), tool: 'write' }],
      },
    ];
    const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
    act(() => {
      holder.renderer = TestRenderer.create(
        <PartDetailSheetHost messages={messages}>
          <CaptureOpener name="main" />
          <PartDetailSheetHost messages={messages}>
            <CaptureOpener name="subagent" />
          </PartDetailSheetHost>
        </PartDetailSheetHost>
      );
    });
    const renderer = holder.renderer;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    act(() => {
      openers.get('main')?.('write-1');
    });
    expect(findByType(renderer.root, 'Modal').filter(node => propOf(node, 'visible'))).toHaveLength(
      1
    );
    act(() => {
      openers.get('subagent')?.('write-1');
    });
    expect(findByType(renderer.root, 'Modal').filter(node => propOf(node, 'visible'))).toHaveLength(
      2
    );
    expect(findByType(renderer.root, 'CenteredState')).toHaveLength(2);
    expect(findByType(renderer.root, 'ScrollView')).toHaveLength(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('defaults to wrap: Wrap radio selected, block renders no inner scroller', async () => {
    const renderer = await mountSheet(makeBashPart('bash-1', 'echo hi'));

    expect(radiogroup(renderer.root)).toBeTruthy();
    expect(radioSelected(renderer.root, 'Wrap')).toBe(true);
    expect(radioSelected(renderer.root, 'Scroll')).toBe(false);
    // Only the sheet's own vertical ScrollView: the block wraps without a scroller.
    expect(findByType(renderer.root, 'ScrollView')).toHaveLength(1);
    // The sheet ScrollView fills the fixed-height Android surface so long
    // content scrolls inside it instead of clipping.
    expect(propOf(sheetScrollView(renderer.root), 'className')).toBe('flex-1');

    await unmount(renderer);
  });

  it('toggles to scroll and keeps the selection across a stream-style rerender', async () => {
    const renderer = await mountSheet(makeBashPart('bash-1', 'echo hi'));

    await act(async () => {
      await Promise.resolve();
      pressRadio(renderer.root, 'Scroll');
    });
    expect(radioSelected(renderer.root, 'Scroll')).toBe(true);
    expect(radioSelected(renderer.root, 'Wrap')).toBe(false);
    expect(findByType(renderer.root, 'ScrollView')).toHaveLength(2);

    // Stream-style rerender: a fresh part object with the same id.
    await act(async () => {
      await Promise.resolve();
      renderer.update(sheetElement(makeBashPart('bash-1', 'echo hi')));
    });
    expect(radioSelected(renderer.root, 'Scroll')).toBe(true);

    await unmount(renderer);
  });

  it('follows the selected mode for error-status mono content and hides the control for command-only bash errors', async () => {
    // An error generic body still carries the input JSON mono block, so the
    // control appears and drives the real error-status mono path.
    const renderer = await mountSheet(makeGenericPart('generic-1', { query: 'x' }, 'error'));

    expect(radiogroup(renderer.root)).toBeTruthy();
    expect(radioSelected(renderer.root, 'Wrap')).toBe(true);
    expect(findByType(renderer.root, 'ScrollView')).toHaveLength(1);

    await act(async () => {
      await Promise.resolve();
      pressRadio(renderer.root, 'Scroll');
    });
    expect(radioSelected(renderer.root, 'Scroll')).toBe(true);
    expect(findByType(renderer.root, 'ScrollView')).toHaveLength(2);

    await unmount(renderer);

    // Error bash body is command-only and mono-free: no control.
    const bashError = await mountSheet(makeBashPart('bash-1', 'echo hi', { status: 'error' }));
    expect(radiogroup(bashError.root)).toBeUndefined();
    await unmount(bashError);
  });

  it('shows the control for running generic input JSON and hides it for command-only bash bodies', async () => {
    // Running generic input JSON is mono (GenericToolCardBody renders the
    // input as a mono block at any status), so the control appears.
    const withMono = await mountSheet(makeGenericPart('generic-1', { query: 'x' }, 'running'));
    expect(radiogroup(withMono.root)).toBeTruthy();
    await unmount(withMono);

    // Running bash command-only is mono-free (the command renders as plain
    // text), so the control stays hidden.
    const withoutMono = await mountSheet(makeBashPart('bash-1', 'echo hi', { status: 'running' }));
    expect(radiogroup(withoutMono.root)).toBeUndefined();
    await unmount(withoutMono);

    // Transition running-no-mono -> completed-with-mono: the control appears
    // with Wrap still selected.
    const renderer = await mountSheet(makeBashPart('bash-2', '', { status: 'running' }));
    expect(radiogroup(renderer.root)).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
      renderer.update(sheetElement(makeBashPart('bash-2', 'echo hi')));
    });
    expect(radiogroup(renderer.root)).toBeTruthy();
    expect(radioSelected(renderer.root, 'Wrap')).toBe(true);

    await unmount(renderer);
  });

  it('keeps the selection across a mono-free gap on the same part id', async () => {
    const renderer = await mountSheet(makeBashPart('bash-1', 'echo hi'));
    await act(async () => {
      await Promise.resolve();
      pressRadio(renderer.root, 'Scroll');
    });
    expect(radioSelected(renderer.root, 'Scroll')).toBe(true);

    // Mono-free gap on the same part id: a completed bash body with no output
    // has no mono block, so the control disappears.
    await act(async () => {
      await Promise.resolve();
      renderer.update(sheetElement(makeBashPart('bash-1', 'echo hi', { output: '' })));
    });
    expect(radiogroup(renderer.root)).toBeUndefined();

    // Mono returns: the control reappears with Scroll still selected — the
    // sheet only resets the mode on close, never on content changes.
    await act(async () => {
      await Promise.resolve();
      renderer.update(sheetElement(makeBashPart('bash-1', 'echo hi')));
    });
    expect(radiogroup(renderer.root)).toBeTruthy();
    expect(radioSelected(renderer.root, 'Scroll')).toBe(true);

    await unmount(renderer);
  });

  it('keeps the control present across a block-replacing part swap in one commit', async () => {
    const renderer = await mountSheet(makeBashPart('bash-1', 'echo hi'));
    expect(radiogroup(renderer.root)).toBeTruthy();

    await act(async () => {
      await Promise.resolve();
      renderer.update(sheetElement(makeBashPart('bash-2', 'ls -la')));
    });

    // Different part id -> the keyed block unmounts and remounts in the same
    // commit; the decrement and increment batch, so no zero-count frame shows.
    expect(radiogroup(renderer.root)).toBeTruthy();

    await unmount(renderer);
  });

  it('shows no control for reasoning parts or null parts', async () => {
    const reasoning = await mountSheet(makeReasoningPart('r1', 'working through it'));
    expect(radiogroup(reasoning.root)).toBeUndefined();
    await unmount(reasoning);

    const nullPart = await mountSheet(null);
    expect(radiogroup(nullPart.root)).toBeUndefined();
    const unavailable = findByType(nullPart.root, 'Text').filter(
      node => propOf(node, 'children') === 'Details unavailable'
    );
    expect(unavailable).toHaveLength(1);
    await unmount(nullPart);
  });

  it('opts its header out of the iOS pageSheet top inset', async () => {
    const renderer = await mountSheet(makeBashPart('bash-1', 'echo hi'));

    // The tool detail sheet is a native pageSheet: the header drops the window
    // top inset on iOS so the title row sits under the grabber, while Android
    // keeps the clearance (read at the SheetHeader boundary, mocked above).
    const headers = findByType(renderer.root, 'SheetHeader');
    expect(headers).toHaveLength(1);
    expect(propOf(headers[0], 'topInset')).toBe('ios-page-sheet');

    await unmount(renderer);
  });
});

describe('PartDetailSheet auto-follow', () => {
  it('renders streaming reasoning as Text and completed reasoning as SelectableText', async () => {
    const streaming = await mountSheet(makeReasoningPart('r1', 'thinking...', { streaming: true }));
    expect(findByType(streaming.root, 'SelectableText')).toHaveLength(0);
    const textNodes = findByType(streaming.root, 'Text').filter(
      node => propOf(node, 'children') === 'thinking...'
    );
    expect(textNodes).toHaveLength(1);
    await unmount(streaming);

    const completed = await mountSheet(makeReasoningPart('r2', 'thought'));
    expect(findByType(completed.root, 'SelectableText')).toHaveLength(1);
    await unmount(completed);
  });

  it('follows growth while at the bottom', async () => {
    const { renderer, scrollToEnd } = await mountSheetWithScroll(
      sheetElement(makeReasoningPart('r1', 'thinking...', { streaming: true }))
    );
    await act(async () => {
      await Promise.resolve();
      contentSizeChange(sheetScrollView(renderer.root), 400);
    });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    await unmount(renderer);
  });

  it('pins the first layout to the bottom', async () => {
    const { renderer, scrollToEnd } = await mountSheetWithScroll(
      sheetElement(makeReasoningPart('r1', 'thinking...', { streaming: true }))
    );
    await act(async () => {
      await Promise.resolve();
      (propOf(sheetScrollView(renderer.root), 'onLayout') as () => void)();
    });
    expect(scrollToEnd).toHaveBeenCalled();
    await unmount(renderer);
  });

  it('never yanks during drag or momentum and stays off away from the bottom', async () => {
    const { renderer, scrollToEnd } = await mountSheetWithScroll(
      sheetElement(makeReasoningPart('r1', 'thinking...', { streaming: true }))
    );
    const scrollView = sheetScrollView(renderer.root);
    const onScrollBeginDrag = propOf(scrollView, 'onScrollBeginDrag') as () => void;
    const onScroll = propOf(scrollView, 'onScroll') as ScrollHandler;
    const onScrollEndDrag = propOf(scrollView, 'onScrollEndDrag') as ScrollHandler;
    const onMomentumScrollBegin = propOf(scrollView, 'onMomentumScrollBegin') as () => void;
    const onMomentumScrollEnd = propOf(scrollView, 'onMomentumScrollEnd') as ScrollHandler;
    const away = scrollEvent({ offsetY: 0, contentHeight: 1000, viewportHeight: 400 });

    await act(async () => {
      await Promise.resolve();
      onScrollBeginDrag();
      contentSizeChange(scrollView, 1200);
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
      onScroll(away);
      onScrollEndDrag(away);
      onMomentumScrollBegin();
      contentSizeChange(scrollView, 1300);
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
      onMomentumScrollEnd(away);
      contentSizeChange(scrollView, 1400);
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    await unmount(renderer);
  });

  it('resumes following when the user returns to the bottom', async () => {
    const { renderer, scrollToEnd } = await mountSheetWithScroll(
      sheetElement(makeReasoningPart('r1', 'thinking...', { streaming: true }))
    );
    const scrollView = sheetScrollView(renderer.root);

    await act(async () => {
      await Promise.resolve();
      dragAwayFromBottom(scrollView);
      contentSizeChange(scrollView, 1200);
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
      (propOf(scrollView, 'onScroll') as ScrollHandler)(
        scrollEvent({ offsetY: 850, contentHeight: 1200, viewportHeight: 400 })
      );
      contentSizeChange(scrollView, 1400);
    });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });

    await unmount(renderer);
  });

  it('never follows a non-streaming part', async () => {
    const { renderer, scrollToEnd } = await mountSheetWithScroll(
      sheetElement(makeReasoningPart('r1', 'thought'))
    );
    const scrollView = sheetScrollView(renderer.root);
    await act(async () => {
      await Promise.resolve();
      contentSizeChange(scrollView, 400);
      (propOf(scrollView, 'onLayout') as () => void)();
    });
    expect(scrollToEnd).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('resets follow state on close and reopen', async () => {
    const { renderer, scrollToEnd } = await mountSheetWithScroll(
      sheetElement(makeReasoningPart('r1', 'thinking...', { streaming: true }))
    );

    await act(async () => {
      await Promise.resolve();
      dragAwayFromBottom(sheetScrollView(renderer.root));
    });

    await act(async () => {
      await Promise.resolve();
      renderer.update(sheetElement(null, false));
    });

    await act(async () => {
      await Promise.resolve();
      renderer.update(
        sheetElement(makeReasoningPart('r2', 'fresh thinking', { streaming: true }), true)
      );
    });

    await act(async () => {
      await Promise.resolve();
      contentSizeChange(sheetScrollView(renderer.root), 500);
    });
    expect(scrollToEnd).toHaveBeenCalled();

    await unmount(renderer);
  });
});

const TRANSLATION_MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

function makeToolPartWithInput(id: string, tool: string, input: Record<string, unknown>): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed',
      input,
      output: '',
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

/** Flush the dynamic client import and the queued request. */
async function settleTranslation(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- real time for the batch window, then the macrotask that settles the dynamic import and request
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20);
      });
    }
  });
}

describe('PartDetailSheet tool-summary translation gate', () => {
  beforeEach(() => {
    requestMock.mockReset();
    readMock.mockReset();
    writeMock.mockReset();
    readMock.mockResolvedValue([]);
    writeMock.mockResolvedValue(undefined);
    setConfig({ enabled: false, model: TRANSLATION_MODEL });
  });

  it('never requests a translation for a deliberately non-translatable tool header', async () => {
    requestMock.mockResolvedValue(['Liste des tâches']);
    setConfig({ enabled: true, model: TRANSLATION_MODEL });

    const renderer = await mountSheet(makeToolPartWithInput('todo-1', 'todoread', {}));
    await settleTranslation();

    expect(requestMock).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('shows the tool name in the header when the row subtitle is empty', async () => {
    setConfig({ enabled: true, model: TRANSLATION_MODEL });

    // A bash call whose `description` is '' projects an empty subtitle; the
    // header must fall back to the tool name, never a blank title.
    const renderer = await mountSheet(makeToolPartWithInput('bash-1', 'bash', { description: '' }));
    await settleTranslation();

    const headers = findByType(renderer.root, 'SheetHeader');
    expect(headers).toHaveLength(1);
    expect(propOf(headers[0], 'title')).toBe('bash');
    expect(requestMock).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('requests a translation for the row subtitle under the content-bearing tool header', async () => {
    requestMock.mockResolvedValue(['lire : app.ts']);
    setConfig({ enabled: true, model: TRANSLATION_MODEL });

    const renderer = await mountSheet(
      makeToolPartWithInput('read-1', 'read', { filePath: 'src/app.ts' })
    );
    await settleTranslation();

    // The header asks for the row's own labelled text (`app.ts`), not the
    // composed `read: app.ts`, so it shares the row's cached entry.
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['app.ts'], model: TRANSLATION_MODEL.id })
    );
    await unmount(renderer);
  });

  it('opens the header on the row translation cached under the part id, with no new request', async () => {
    requestMock.mockResolvedValue(['Fichier cache-me.ts']);
    setConfig({ enabled: true, model: TRANSLATION_MODEL });

    // A part id this suite does not otherwise use: the runtime caches by item
    // id and only a test's own entry may serve it.
    const cachedPart = (): ToolPart =>
      makeToolPartWithInput('read-cache-1', 'read', { filePath: 'src/cache-me.ts' });

    // First open: the row and the header share the part id, so the one request
    // resolves the subtitle and the runtime caches it under `read-cache-1`.
    const first = await mountSheet(cachedPart());
    await settleTranslation();
    expect(requestMock).toHaveBeenCalledTimes(1);
    await unmount(first);

    requestMock.mockClear();

    const second = await mountSheet(cachedPart());
    await settleTranslation();

    expect(requestMock).not.toHaveBeenCalled();
    const headers = findByType(second.root, 'SheetHeader');
    expect(headers).toHaveLength(1);
    expect(propOf(headers[0], 'title')).toBe('read: Fichier cache-me.ts');
    await unmount(second);
  });
});
