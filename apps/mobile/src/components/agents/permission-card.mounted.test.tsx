import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type BlockingCardSubmissionError } from './blocking-card-state';
import { PermissionCard } from './permission-card';

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({}),
}));
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: vi.fn(),
  requestA11yFocus: vi.fn(),
}));

function findByAccessibilityLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.props.accessibilityLabel === label);
}

/** Every literal string child of a rendered text node, in tree order. */
function textLines(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(node => node.type === 'Text')
    .flatMap(node => node.children.filter(value => typeof value === 'string'));
}

type CardOverrides = {
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  submissionError?: BlockingCardSubmissionError | null;
  onRespond?: (response: 'once' | 'always' | 'reject') => void;
};

async function renderCard(overrides: CardOverrides = {}) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(PermissionCard, {
        permission: 'bash',
        patterns: [],
        onRespond: () => undefined,
        requestId: 'perm-req-1',
        ...overrides,
      })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('PermissionCard mounted', () => {
  it('shows the command alone when a bash request carries one', async () => {
    const renderer = await renderCard({
      patterns: ['rg todo 2_/dev/null'],
      metadata: { command: 'rg todo 2>/dev/null' },
    });
    const lines = textLines(renderer.root);

    expect(lines).not.toContain(i18n.t('agentChat.permissionCard.appliesTo'));
    expect(lines).not.toContain('rg todo 2_/dev/null');
    expect(lines).toContain(i18n.t('profiles.commandLabel'));
    expect(lines).toContain('rg todo 2>/dev/null');
  });

  it('keeps the patterns for a request that has no command', async () => {
    const renderer = await renderCard({
      permission: 'external_directory',
      patterns: ['/var/tmp/scope/**'],
    });
    const lines = textLines(renderer.root);

    expect(lines).toContain(i18n.t('agentChat.permissionCard.appliesTo'));
    expect(lines).toContain('/var/tmp/scope/**');
    expect(lines).not.toContain(i18n.t('profiles.commandLabel'));
  });

  it('shows neither block when the request has no patterns and no command', async () => {
    const renderer = await renderCard({ permission: 'external_directory' });
    const lines = textLines(renderer.root);

    expect(lines).not.toContain(i18n.t('agentChat.permissionCard.appliesTo'));
    expect(lines).not.toContain(i18n.t('profiles.commandLabel'));
  });

  it('hides Always allow for a skillShell request and keeps Allow once and Deny', async () => {
    const renderer = await renderCard({
      metadata: { skillShell: true, skill: 'e2e', commands: ['echo hi'] },
    });

    expect(findByAccessibilityLabel(renderer.root, 'Always allow')).toHaveLength(0);
    expect(findByAccessibilityLabel(renderer.root, 'Allow once')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Deny permission')).toHaveLength(1);
  });

  it('keeps Always allow when metadata is undefined', async () => {
    const renderer = await renderCard();

    expect(findByAccessibilityLabel(renderer.root, 'Always allow')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Allow once')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Deny permission')).toHaveLength(1);
  });

  it('keeps Always allow when metadata is empty', async () => {
    const renderer = await renderCard({ metadata: {} });

    expect(findByAccessibilityLabel(renderer.root, 'Always allow')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Allow once')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Deny permission')).toHaveLength(1);
  });

  it.each([
    ['reject', 'Retry deny'],
    ['once', 'Retry allow once'],
    ['always', 'Retry always allow'],
  ] as const)(
    'retries the recorded %s decision after a failure',
    async (permissionResponse, label) => {
      const onRespond = vi.fn<(response: 'once' | 'always' | 'reject') => void>();
      const renderer = await renderCard({
        onRespond,
        submissionError: {
          kind: 'retryable',
          message: 'Failed to respond to permission. Please try again.',
          action: 'respond',
          permissionResponse,
        },
      });

      expect(
        renderer.root.findByProps({
          children: 'Failed to respond to permission. Please try again.',
        })
      ).toBeDefined();
      const [retry] = findByAccessibilityLabel(renderer.root, label);
      if (!retry) {
        throw new Error(`missing retry control: ${label}`);
      }
      act(() => {
        (retry.props.onPress as () => void)();
      });

      expect(onRespond).toHaveBeenCalledExactlyOnceWith(permissionResponse);
      expect(findByAccessibilityLabel(renderer.root, 'Deny permission')).toHaveLength(0);
      expect(findByAccessibilityLabel(renderer.root, 'Allow once')).toHaveLength(0);
    }
  );

  it('offers the decision controls again when the failure recorded no decision', async () => {
    const renderer = await renderCard({
      submissionError: {
        kind: 'retryable',
        message: 'Failed to respond to permission. Please try again.',
        action: 'respond',
        permissionResponse: null,
      },
    });

    expect(findByAccessibilityLabel(renderer.root, 'Retry deny')).toHaveLength(0);
    expect(findByAccessibilityLabel(renderer.root, 'Retry allow once')).toHaveLength(0);
    expect(findByAccessibilityLabel(renderer.root, 'Retry always allow')).toHaveLength(0);
    expect(findByAccessibilityLabel(renderer.root, 'Deny permission')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Allow once')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Always allow')).toHaveLength(1);
  });
});
