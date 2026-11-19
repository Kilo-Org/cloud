// The deny list row's label: the model name with the localized retirement note
// the old composed English suffix carried (`Retires Nov 20`), worded in the
// active language from `retires_on`, and absent when the entry carries no date.

import { Fragment, type ReactElement, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance, ReactTestRenderer } from '@/test/renderer';

import { act, TestRenderer } from '@/test/renderer';

import '@/i18n';
import { i18n } from '@/i18n';
import { type ModelAccessDraft } from '@/lib/organization/model-access';
import { ModelDenyList } from './model-access-lists';

type RowProps = {
  label: string;
  description: string;
  value: boolean;
};

const rows: RowProps[] = [];

vi.mock('react-native', () => ({
  View: 'View',
  Animated: { createAnimatedComponent: (component: unknown) => component, View: 'View' },
}));

// The deny list renders its rows through FlashList; a mock harness renders the
// rows directly, so the real RecyclerView (whose `Animated.Value` a jsdom
// render cannot build) never mounts.
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactElement;
  }) =>
    createElement(
      'View',
      null,
      (props.data ?? []).map((item, index) =>
        createElement(Fragment, { key: index }, props.renderItem?.({ item, index }))
      )
    ),
}));
vi.mock('@/components/organization/settings-form-sections', () => ({
  // Record the row props the list renders, as the form-mounted tests read
  // their own child props.
  SettingsSwitchRow: (props: RowProps) => {
    rows.push({ label: props.label, description: props.description, value: props.value });
    return null;
  },
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/filter-chip', () => ({ FilterChip: 'FilterChip' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/icons', () => ({ SearchX: 'SearchX' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));

const EMPTY_DRAFT: ModelAccessDraft = { providerAllowList: [], modelDenyList: [] };

function render(
  models: readonly { id: string; name: string; retiresOn?: string }[]
): ReactTestRenderer {
  rows.length = 0;
  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(ModelDenyList, {
        models,
        draft: EMPTY_DRAFT,
        onChange: () => undefined,
        disabled: false,
      })
    );
  });
  if (!ref.current) {
    throw new Error('Missing renderer');
  }
  return ref.current;
}

function labels(root: ReactTestInstance): string[] {
  return rows.map(row => row.label);
}

// Locale cases switch the shared instance; put English back so the remaining
// cases keep rendering the English catalog.
afterEach(async () => {
  if (i18n.language !== 'en') {
    await i18n.changeLanguage('en');
  }
});

describe('ModelDenyList retirement note', () => {
  it('appends the English note with the UTC short date after the name', () => {
    const renderer = render([
      { id: 'openai/gpt', name: 'GPT', retiresOn: '2026-11-20' },
      { id: 'meta/llama', name: 'Llama' },
    ]);

    expect(labels(renderer.root)).toEqual(['GPT (Retires Nov 20)', 'Llama']);
  });

  it('words the note in the row language of the Hindi catalog', async () => {
    await i18n.changeLanguage('hi');
    try {
      const renderer = render([{ id: 'openai/gpt', name: 'GPT', retiresOn: '2026-11-20' }]);

      expect(labels(renderer.root)).toEqual(['GPT (20 नव॰ को बंद हो जाएगा)']);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('keeps the label bare when the entry carries no date', () => {
    const renderer = render([{ id: 'openai/gpt', name: 'GPT' }]);

    expect(labels(renderer.root)).toEqual(['GPT']);
  });
});
