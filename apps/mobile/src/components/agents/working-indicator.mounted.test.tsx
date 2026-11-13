import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { WorkingIndicator } from './working-indicator';

// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. Provide a real context
// so any `useContext(TextClassContext)` consumer still resolves.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

/** An assistant turn whose last part is the bash call the ask blocks. */
function blockedBashMessages(): StoredMessage[] {
  return [
    {
      info: {
        id: 'msg-blocked',
        sessionID: 'ses-1',
        role: 'assistant',
        time: { created: 1 },
        parentID: 'msg-user',
        modelID: 'model',
        providerID: 'provider',
        mode: 'code',
        agent: 'code',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: 'prt-bash',
          sessionID: 'ses-1',
          messageID: 'msg-blocked',
          type: 'tool',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'running', input: { command: 'pnpm test' }, time: { start: 1 } },
        },
      ],
    },
  ];
}

type MountProps = {
  blockingInteraction?: 'none' | 'permission' | 'question';
  isStreaming?: boolean;
};

async function mount(props: MountProps = {}) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(() => {
    rendererRef.current = TestRenderer.create(
      createElement(WorkingIndicator, {
        messages: blockedBashMessages(),
        isStreaming: props.isStreaming ?? true,
        blockingInteraction: props.blockingInteraction ?? 'none',
      })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** The row's single text line, e.g. `Waiting for permission · 12 sec`. */
function rowText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string')
    .join('');
}

/** Advances the clock inside `act`, so the interval's tick reaches the tree. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage('en');
});

describe('WorkingIndicator', () => {
  it('names the blocked permission ask instead of the tool activity', async () => {
    vi.useFakeTimers();
    const renderer = await mount({ blockingInteraction: 'permission' });

    expect(rowText(renderer)).toContain(en.agentChat.computeStatus.waitingForPermission);
    expect(rowText(renderer)).not.toContain(en.agentChat.computeStatus.runningCommands);
  });

  it('names a pending question', async () => {
    vi.useFakeTimers();
    const renderer = await mount({ blockingInteraction: 'question' });

    expect(rowText(renderer)).toContain(en.agentChat.computeStatus.askingQuestion);
    expect(rowText(renderer)).not.toContain(en.agentChat.computeStatus.runningCommands);
  });

  it('reads the tool activity while nothing blocks the agent', async () => {
    vi.useFakeTimers();
    const renderer = await mount();

    expect(rowText(renderer)).toContain(en.agentChat.computeStatus.runningCommands);
  });

  it('holds the counter still while the ask is pending and resumes after the answer', async () => {
    vi.useFakeTimers();
    const renderer = await mount();

    await tick(5000);
    expect(rowText(renderer)).toContain('5 sec');

    // The ask arrives: the work before it is banked and the number stops.
    await act(() => {
      renderer.update(
        createElement(WorkingIndicator, {
          messages: blockedBashMessages(),
          isStreaming: true,
          blockingInteraction: 'permission',
        })
      );
    });
    const whileWaiting = rowText(renderer);
    expect(whileWaiting).toContain(en.agentChat.computeStatus.waitingForPermission);
    expect(whileWaiting).toContain('5 sec');
    await tick(60_000);
    expect(rowText(renderer)).toBe(whileWaiting);

    // Answering the ask resumes the work counter from the banked value.
    await act(() => {
      renderer.update(
        createElement(WorkingIndicator, {
          messages: blockedBashMessages(),
          isStreaming: true,
          blockingInteraction: 'none',
        })
      );
    });
    expect(rowText(renderer)).toContain(en.agentChat.computeStatus.runningCommands);
    await tick(3000);
    expect(rowText(renderer)).toContain('8 sec');
  });

  it('renders the ask in the reader’s catalog', async () => {
    vi.useFakeTimers();
    await i18n.changeLanguage('ar');
    const renderer = await mount({ blockingInteraction: 'permission' });

    expect(rowText(renderer)).toContain(ar.agentChat.computeStatus.waitingForPermission);
  });
});
