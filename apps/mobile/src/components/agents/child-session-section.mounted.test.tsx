/* eslint-disable max-lines -- mounted suite pins the subagent card's translation gate through the real hook and a mocked gateway client */
import '@/i18n';
import { createElement } from 'react';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setConfig } from '@/lib/tool-summary-translation/tool-summary-translation-runtime';

import { ChildSessionSection } from './child-session-section';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('@/lib/tool-summary-translation/tool-summary-translation-client', () => ({
  requestToolSummaryTranslation: requestMock,
}));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  I18nManager: { isRTL: false },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('@/components/ui/icons', () => ({ Bot: 'Bot', Loader2: 'Loader2' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: 'SpinningIcon' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#999999',
    agentSky: '#5B9BD5',
    info: '#2D7DD2',
    good: '#3FA34D',
    destructive: '#BE4E3F',
  }),
}));
vi.mock('./child-session-model-label', () => ({
  ChildSessionModelLabel: 'ChildSessionModelLabel',
}));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

function makeTaskPart(input: Record<string, unknown>): ToolPart {
  return {
    id: 'task-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    tool: 'task',
    callID: 'call-1',
    state: { status: 'pending', input, raw: '' },
  };
}

async function mountSection(
  input: Record<string, unknown>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(ChildSessionSection, {
        part: makeTaskPart(input),
        childMessages: [],
        onOpenChildSession: vi.fn<() => void>(),
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** Flush the dynamic client import and the queued request. */
async function settleTranslation(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential macrotask flushes settle the dynamic import and request
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
    }
  });
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function textValues(root: TestRenderer.ReactTestInstance): unknown[] {
  return findByType(root, 'Text').map(node => node.props.children);
}

describe('ChildSessionSection tool-summary translation gate', () => {
  beforeEach(() => {
    requestMock.mockReset();
    setConfig({ enabled: false, model: MODEL });
  });

  it('never requests a translation for the already-localized fallback task label', async () => {
    requestMock.mockResolvedValue('Tâche');
    setConfig({ enabled: true, model: MODEL });

    const renderer = await mountSection({});
    await settleTranslation();

    expect(requestMock).not.toHaveBeenCalled();
    expect(textValues(renderer.root)).toContain('Task');
    expect(textValues(renderer.root)).not.toContain('Tâche');
    act(() => {
      renderer.unmount();
    });
  });

  it('requests a translation for a description-derived task name', async () => {
    requestMock.mockResolvedValue('Tâche enfant');
    setConfig({ enabled: true, model: MODEL });

    const renderer = await mountSection({ description: 'child task' });
    await settleTranslation();

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'child task', model: MODEL.id })
    );
    expect(textValues(renderer.root)).toContain('Tâche enfant');
    act(() => {
      renderer.unmount();
    });
  });

  it('requests a translation for a prompt-derived task name', async () => {
    requestMock.mockResolvedValue('Faire la chose');
    setConfig({ enabled: true, model: MODEL });

    const renderer = await mountSection({ prompt: 'do the thing' });
    await settleTranslation();

    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ text: 'do the thing' }));
    act(() => {
      renderer.unmount();
    });
  });
});
