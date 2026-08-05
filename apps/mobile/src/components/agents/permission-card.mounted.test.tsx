/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as reasoning-part-renderer.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { PermissionCard } from './permission-card';

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
  moveA11yFocus: vi.fn(),
}));

function findByAccessibilityLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.props.accessibilityLabel === label);
}

async function renderCard(metadata: Record<string, unknown> | undefined) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(PermissionCard, {
        permission: 'bash',
        patterns: [],
        metadata,
        onRespond: () => undefined,
        requestId: 'perm-req-1',
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
  it('hides Always allow for a skillShell request and keeps Allow once and Deny', async () => {
    const renderer = await renderCard({
      skillShell: true,
      skill: 'e2e',
      commands: ['echo hi'],
    });

    expect(findByAccessibilityLabel(renderer.root, 'Always allow')).toHaveLength(0);
    expect(findByAccessibilityLabel(renderer.root, 'Allow once')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Deny permission')).toHaveLength(1);
  });

  it('keeps Always allow when metadata is undefined', async () => {
    const renderer = await renderCard(undefined);

    expect(findByAccessibilityLabel(renderer.root, 'Always allow')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Allow once')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Deny permission')).toHaveLength(1);
  });

  it('keeps Always allow when metadata is empty', async () => {
    const renderer = await renderCard({});

    expect(findByAccessibilityLabel(renderer.root, 'Always allow')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Allow once')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Deny permission')).toHaveLength(1);
  });
});
