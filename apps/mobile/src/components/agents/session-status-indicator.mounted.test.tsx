import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SessionStatusIndicator as SessionStatusIndicatorType } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import { CATALOG_LOADERS } from '@/i18n/catalogs';
import es from '@/i18n/locales/es.json';
import { SessionStatusIndicator } from './session-status-indicator';

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

/**
 * Put the singleton on Spanish with the real catalog loaded. The lazy backend
 * only fetches a language once, so a catalog a previous test removed with
 * `removeResourceBundle` is not re-fetched; loading the bundle directly keeps
 * each test independent of that cache. The five `agentChat.status` keys are
 * installed here because the translation slice has not added them to the
 * non-English catalogs yet.
 */
async function useSpanishStatusCopy(): Promise<void> {
  await i18n.changeLanguage('es');
  i18n.addResourceBundle('es', 'translation', CATALOG_LOADERS.es(), true, true);
  i18n.addResource('es', 'translation', 'agentChat.status.committing', 'Confirmando…');
  i18n.addResource('es', 'translation', 'agentChat.status.committed', 'Confirmado');
  i18n.addResource('es', 'translation', 'agentChat.status.commitFailed', 'Error al confirmar');
  i18n.addResource('es', 'translation', 'agentChat.status.sessionStopped', 'Sesión detenida');
  i18n.addResource('es', 'translation', 'agentChat.status.sessionTerminated', 'Sesión terminada');
}

describe('SessionStatusIndicator mounted', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

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

  // The SDK writes these lines itself; each is pinned to a catalog key, so the
  // indicator shows the reader their own language, never the English literal.
  it.each([
    ['Agent connection lost', es.agentChat.session.connectionTrouble],
    ['Session terminated', 'Sesión terminada'],
    ['Failed to stop execution', es.agentChat.session.failedToStopExecution],
    ['Commit failed', 'Error al confirmar'],
  ] as const)('localizes the SDK fixed copy for %s', async (message, translated) => {
    await useSpanishStatusCopy();
    const texts = await textNodes({ type: 'error', message, timestamp: 0 });
    expect(texts).toEqual([translated]);
    expect(texts.join(' ')).not.toContain(message);
    i18n.removeResourceBundle('es', 'translation');
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

  it('localizes a pinned progress message', async () => {
    await useSpanishStatusCopy();
    const texts = await textNodes({
      type: 'progress',
      message: 'Setting up environment…',
      timestamp: 0,
    });
    expect(texts).toEqual([es.agentChat.composer.preparingPlaceholder]);
    expect(texts.join(' ')).not.toContain('Setting up environment');
    i18n.removeResourceBundle('es', 'translation');
  });

  it('localizes a pinned info message', async () => {
    await useSpanishStatusCopy();
    const texts = await textNodes({ type: 'info', message: 'Session stopped', timestamp: 0 });
    expect(texts).toEqual(['Sesión detenida']);
    expect(texts.join(' ')).not.toContain('Session stopped');
    i18n.removeResourceBundle('es', 'translation');
  });
});
