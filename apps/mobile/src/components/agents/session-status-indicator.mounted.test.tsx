import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { type SessionStatusIndicator as SessionStatusIndicatorType } from '@kilocode/cloud-agent-sdk';

import { SessionStatusIndicator } from './session-status-indicator';
import { i18n } from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

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
vi.mock('@/components/ui/icons', async () => {
  const React = await import('react');
  const Icon = (props: Record<string, unknown>) => React.createElement('Icon', props);
  return { AlertCircle: Icon, Check: Icon };
});
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#ff0000', warn: '#ffaa00', mutedForeground: '#666666' }),
}));

/** Every rendered text node, so an assertion can prove the raw string is absent. */
async function textNodes(indicator: SessionStatusIndicatorType): Promise<string[]> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(SessionStatusIndicator, { indicator }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer.root
    .findAllByType('Text')
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

describe('SessionStatusIndicator mounted', () => {
  it('renders typed copy, never the raw provider text, for a session error', async () => {
    await expect(
      textNodes({ type: 'error', message: 'simulated error', timestamp: 0 })
    ).resolves.toEqual(['The response failed.']);
  });

  it('never renders an unrecognized transport string', async () => {
    await expect(
      textNodes({ type: 'error', message: 'Unauthorized: Unauthorized', timestamp: 0 })
    ).resolves.toEqual(['The response failed.']);
  });

  // The DO's safe projection writes the same credits failure lowercase.
  it('renders the credits copy for the DO projection', async () => {
    await expect(
      textNodes({
        type: 'error',
        message: 'Assistant request failed: insufficient credits',
        timestamp: 0,
      })
    ).resolves.toEqual(['Not enough credits to run Cloud Agent. Add credits and try again.']);
  });

  // The DO's safe projection is already the reader's copy and has no translated
  // counterpart, so the status line shows it unchanged.
  it.each([
    ['Workspace setup failed'],
    ['Repository authentication failed'],
    ['Agent wrapper disconnected'],
    ['Commit failed'],
  ] as const)('shows the safe projection copy for %s', async message => {
    await expect(textNodes({ type: 'error', message, timestamp: 0 })).resolves.toEqual([message]);
  });

  it('renders the classified copy for a recognized session error', async () => {
    await expect(
      textNodes({
        type: 'error',
        message: 'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
        timestamp: 0,
      })
    ).resolves.toEqual(['Not enough credits to run Cloud Agent. Add credits and try again.']);
  });

  // The SDK codes the fixed lines it writes itself, so the status line renders
  // the app's catalog copy instead of the SDK's English message.
  it.each([
    ['agent-connection-lost', 'Agent connection lost', 'Connection lost'],
    ['session-terminated', 'Session terminated', 'The response failed.'],
    ['failed-to-stop-execution', 'Failed to stop execution', 'Failed to stop execution'],
  ] as const)('renders the %s code as catalog copy', async (code, message, expected) => {
    await expect(textNodes({ type: 'error', message, code, timestamp: 0 })).resolves.toEqual([
      expected,
    ]);
  });

  // The code is locale-free, so the same indicator renders in the reader's
  // language once the catalog changes. German already carries this key.
  it('renders the German copy for the agent-connection-lost code', async () => {
    await i18n.changeLanguage('de');
    try {
      await expect(
        textNodes({
          type: 'error',
          message: 'Agent connection lost',
          code: 'agent-connection-lost',
          timestamp: 0,
        })
      ).resolves.toEqual([de.agentChat.sessionConnection.connectionLost]);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('renders the delivery copy for the SDK delivery status', async () => {
    await expect(
      textNodes({ type: 'error', message: 'Message delivery failed', timestamp: 0 })
    ).resolves.toEqual(['Failed to deliver']);
  });

  it('renders fixed retry copy, never the provider text, while the agent retries', async () => {
    const texts = await textNodes({
      type: 'warning',
      message:
        'Retrying… Service Unavailable: The service is temporarily unavailable. Please try again later.',
      timestamp: 0,
    });
    expect(texts).toEqual(['Retrying…']);
    expect(texts.join(' ')).not.toContain('Service Unavailable');
  });

  // A coded progress line renders catalog copy; a code-less line (autocommit
  // event text) keeps the message the SDK forwarded.
  it('renders catalog copy for a coded progress line', async () => {
    await expect(
      textNodes({
        type: 'progress',
        message: 'Setting up environment…',
        code: 'setting-up-environment',
        timestamp: 0,
      })
    ).resolves.toEqual([en.agentChat.composer.preparingPlaceholder]);
  });

  it('leaves a code-less progress message alone', async () => {
    await expect(
      textNodes({ type: 'progress', message: 'Setting up environment…', timestamp: 0 })
    ).resolves.toEqual(['Setting up environment…']);
  });

  it('renders catalog copy for a coded info line', async () => {
    await expect(
      textNodes({ type: 'info', message: 'Autocommit completed', code: 'committed', timestamp: 0 })
    ).resolves.toEqual([en.agentChat.session.committed]);
  });

  it('leaves a code-less info message alone', async () => {
    await expect(
      textNodes({ type: 'info', message: 'Session stopped', timestamp: 0 })
    ).resolves.toEqual(['Session stopped']);
  });
});
