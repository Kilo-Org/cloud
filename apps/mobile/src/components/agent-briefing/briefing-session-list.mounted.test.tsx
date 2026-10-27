import { type ElementType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type BriefingReport } from '@/lib/agent-briefing';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { BriefingSessionList } from './briefing-session-list';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn<() => void>() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { shown?: number; total?: number }) =>
      values?.total === undefined ? key : `${key}:${values.shown}/${values.total}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ setOrganizationId: vi.fn<() => void>() }),
}));
vi.mock('./briefing-session-href', () => ({ briefingSessionHref: () => '/session' }));

type Session = BriefingReport['sessions'][number];

function session(index: number, sources: number, omittedSources?: number): Session {
  return {
    sessionId: `ses_${index}`,
    title: `Session ${index}`,
    url: `/cloud/sessions/ses_${index}`,
    status: null,
    spendMicrodollars: 0,
    sources: Array.from({ length: sources }, (_, source) => ({
      id: `source-${index}-${source}`,
      sessionId: `ses_${index}`,
      kind: 'activity' as const,
      title: 'Session activity',
      url: `/cloud/sessions/ses_${index}`,
      occurredAt: '2026-10-15T02:00:00.000Z',
    })),
    ...(omittedSources === undefined ? {} : { omittedSources }),
  };
}

function renderedTexts(sessions: Session[], omittedCollectedSessions?: number): string[] {
  const report = {
    context: { id: 'personal', organizationId: null, name: 'Personal' },
    coverage: {
      activity: 'complete',
      spend: 'complete',
      blockers: 'complete',
      pullRequests: 'complete',
    },
    sessions,
    ...(omittedCollectedSessions === undefined ? {} : { omittedCollectedSessions }),
  } as unknown as BriefingReport;
  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(<BriefingSessionList report={report} />);
  });
  if (!ref.current) {
    throw new Error('BriefingSessionList did not mount');
  }
  return ref.current.root
    .findAllByType('Text' as ElementType)
    .map(node => String(node.props.children));
}

describe('BriefingSessionList', () => {
  it('shows how many sessions and items the report left out', () => {
    const texts = renderedTexts([session(1, 32, 2017), session(2, 3, 0)], 236);
    expect(texts).toContain('agentBriefing.itemsShown:32/2049');
    expect(texts.filter(text => text.startsWith('agentBriefing.itemsShown'))).toHaveLength(1);
    expect(texts.at(-1)).toBe('agentBriefing.sessionsShown:2/238');
  });

  it('shows no count line when nothing was left out', () => {
    for (const texts of [renderedTexts([session(1, 3, 0)], 0), renderedTexts([session(1, 3)])]) {
      expect(texts.some(text => text.includes('Shown'))).toBe(false);
    }
  });
});
