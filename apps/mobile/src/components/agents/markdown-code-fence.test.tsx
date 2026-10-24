import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownCodeFence } from './markdown-code-fence';

const mocks = vi.hoisted(() => ({ performCopy: vi.fn() }));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('@/components/ui/icons', () => ({ Clipboard: 'Clipboard' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./code-block', () => ({ CodeBlock: 'CodeBlock' }));
vi.mock('./use-message-copy', () => ({ performCopy: mocks.performCopy }));

// A long line is exactly the fence content that was clipped: the block it goes
// to wraps outside the tool detail sheet instead of scrolling.
const LONG_LINE = 'const handler = (event: ChangeEvent) => applyReducer(state, event.detail);';
const LONG_FENCE = `const a = 1;\n${LONG_LINE}\nreturn initial.state;`;

const palette = {
  textColor: '#111111',
  mutedTextColor: '#666666',
  codeBackground: '#f4f4f4',
  borderColor: '#cccccc',
};

type Props = Parameters<typeof MarkdownCodeFence>[0];

function fence(props: Partial<Props> = {}): React.ReactElement {
  return React.createElement(MarkdownCodeFence, {
    code: LONG_LINE,
    language: 'ts',
    palette,
    selectable: false,
    ...props,
  });
}

async function mount(element: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(element);
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

/** The single host element of `type`, whose props the suite reads. */
function hostProps(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): Record<string, unknown> {
  const node = renderer.root.findAllByType(type as unknown as React.ComponentType<unknown>)[0];
  if (node === undefined) {
    throw new Error(`no ${type} host`);
  }
  return node.props as Record<string, unknown>;
}

function hostCount(renderer: TestRenderer.ReactTestRenderer, type: string): number {
  return renderer.root.findAllByType(type as unknown as React.ComponentType<unknown>).length;
}

describe('MarkdownCodeFence', () => {
  it('draws the fence content with the wrapping code block, not a scroller', async () => {
    const renderer = await mount(fence());
    expect(hostProps(renderer, 'CodeBlock')).toMatchObject({
      code: LONG_LINE,
      language: 'ts',
      selectable: false,
      baseColor: palette.textColor,
    });
    expect(hostCount(renderer, 'ScrollView')).toBe(0);
  });

  it('keeps the fence language in the header and leaves it blank when unnamed', async () => {
    const named = await mount(fence());
    expect(hostProps(named, 'Text').children).toBe('ts');

    const unnamed = await mount(fence({ language: null }));
    expect(hostProps(unnamed, 'Text').children).toBe('');
    expect(hostProps(unnamed, 'CodeBlock')).toMatchObject({ language: null });
  });

  it('copies the fence source through the host handler', async () => {
    const onCopyCode = vi.fn((_code: string) => undefined);
    const renderer = await mount(fence({ onCopyCode }));

    const button = hostProps(renderer, 'IconButton');
    expect(button).toMatchObject({ accessibilityLabel: 'common.copy' });
    act(() => {
      (button.onPress as () => void)();
    });
    expect(onCopyCode).toHaveBeenCalledWith(LONG_LINE);
  });

  it('copies through the shared clipboard helper when the host passes no handler', async () => {
    const renderer = await mount(fence());

    act(() => {
      (hostProps(renderer, 'IconButton').onPress as () => void)();
    });
    expect(mocks.performCopy).toHaveBeenCalledWith(LONG_LINE);
  });

  it('passes a multi-line fence through unchanged', async () => {
    const renderer = await mount(fence({ code: LONG_FENCE }));
    expect(hostProps(renderer, 'CodeBlock')).toMatchObject({ code: LONG_FENCE });
  });
});
