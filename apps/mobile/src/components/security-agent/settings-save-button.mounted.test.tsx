// The Security Agent settings Save action is a variable-width header action:
// its label grows with the font scale. ScreenHeader's trailing cluster is
// content-sized and never shrinks (`screen-header.tsx`), so the heading
// absorbs the squeeze — and with nothing bounding this action, the cluster
// consumes the row and the title collapses to zero before the cluster
// overflows the screen edge. The action must bound itself at its source, the
// same contract pr-review's Submit review follows (`pr-review-screen.tsx`).

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

// Mounting the real Button pulls in `@/lib/utils`, which imports the app's i18n
// instance: load it for real (as the other mounted suites do) instead of
// mocking react-i18next, whose partial mock breaks the instance's init.
import '@/i18n';
import { SettingsSaveButton } from './settings-save-button';

vi.mock('react-native', () => ({ Pressable: 'Pressable' }));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
  TextClassContext: { Provider: 'TextClassContextProvider' },
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#fff' }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }));

// The narrowest viewport the app supports, and the fixed chrome the header row
// has already spent before the heading and this cluster: the outer `px-4`
// gutter (32 dp), the 44 dp back control pulled 16 dp into that gutter by
// `-ms-4` (28 dp), the heading row's `gap-1` (4 dp) and the cluster's `ms-3`
// (12 dp).
const NARROWEST_VIEWPORT_DP = 320;
const HEADER_ROW_CHROME_DP = 32 + 28 + 4 + 12;
/** What the title still needs to draw a truncated line and its ellipsis. */
const TITLE_FLOOR_DP = 96;

/** This suite exercises layout only: the save resolves and is never asserted. */
async function noopSave(): Promise<void> {
  await Promise.resolve();
}

function renderSaveButton(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SettingsSaveButton, {
        dirty: true,
        valid: true,
        pending: false,
        onSave: noopSave,
        skipNextGuardRef: { current: false },
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findSaveButton(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const button = root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
  )[0];
  if (!button) {
    throw new Error('save Button not found');
  }
  return button;
}

function findLabel(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const label = root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Text'
  )[0];
  if (!label) {
    throw new Error('save label not found');
  }
  return label;
}

function maxWidthCap(className: string): number {
  const match = /max-w-\[(\d+)px\]/.exec(className);
  if (!match) {
    throw new Error(`no px max-width cap in the header action: ${className}`);
  }
  return Number(match[1]);
}

describe('SettingsSaveButton header cap', () => {
  it('bounds its own width so the header title keeps a floor on the narrowest viewport', () => {
    const button = findSaveButton(renderSaveButton().root);
    const cap = maxWidthCap(button.props.className as string);

    // Cap 140 dp leaves the heading 104 dp at 320 dp. Uncapped, the label's
    // scale-2 width (~192 dp) leaves 52 dp, and at accessibility text sizes it
    // takes the whole row and the title disappears instead of truncating.
    expect(NARROWEST_VIEWPORT_DP - HEADER_ROW_CHROME_DP - cap).toBeGreaterThanOrEqual(
      TITLE_FLOOR_DP
    );
  });

  it('lets the label shrink and wrap inside the cap instead of painting past the screen edge', () => {
    const root = renderSaveButton().root;
    const className = findSaveButton(root).props.className as string;

    // Button's base class is `shrink-0`; the action's own `shrink` must win in
    // `cn()`'s merge or the capped box would clamp while the label kept its
    // full width and painted outside it.
    expect(className).toContain('min-w-0');
    expect(className).not.toContain('shrink-0');
    expect(findLabel(root).props.className).toContain('shrink');
  });
});
