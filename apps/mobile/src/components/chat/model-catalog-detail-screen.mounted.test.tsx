import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type HfModelDetail } from '@/lib/chat/hf-catalog';

import { ModelCatalogDetailScreen } from './model-catalog-detail-screen';

// The detail query is the only data the summary needs, so it is answered from a
// fixture and the screen renders its real header off the real catalogs.
const detail = vi.hoisted(() => ({ current: undefined as HfModelDetail | undefined }));

vi.mock('@/lib/chat/use-hf-catalog', () => ({
  HfRequestError: class HfRequestError extends Error {
    readonly status = 0;
  },
  useDeviceBudget: () => ({ memoryBytes: 8_000_000_000, freeBytes: 4_000_000_000 }),
  useHfModelDetail: () => ({ data: detail.current, isError: false, isPending: false }),
}));
vi.mock('@/lib/chat/gguf-models', () => ({
  ggufDownloadActions: () => [],
  useGgufModels: () => ({}),
}));
vi.mock('./gguf-model-section', () => ({ GgufDownloadControls: 'GgufDownloadControls' }));
// The real component renders the header and the summary through FlashList's
// header slot, so a host-string stub would drop the only content under test.
vi.mock('@shopify/flash-list', async () => {
  const React = await import('react');
  return {
    FlashList: (props: { ListHeaderComponent?: ReactNode }) =>
      React.createElement('FlashList', null, props.ListHeaderComponent ?? null),
  };
});
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  View: 'View',
}));
// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose
// `node_modules` `.mjs` contains JSX this pipeline cannot transform.
// `vitest` hoists these factories above the file's imports, so each one that
// needs React reaches it through its own dynamic import.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/icons', async () => {
  const React = await import('react');
  const Icon = (props: Record<string, unknown>) => React.createElement('Icon', props);
  return {
    Cpu: Icon,
    DirectionalChevronRight: Icon,
    Download: Icon,
    Eye: Icon,
    FileSearch: Icon,
    FileText: Icon,
    Lock: Icon,
    Scale: Icon,
    Star: Icon,
    Wrench: Icon,
  };
});
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666', warn: '#ffaa00' }),
}));

const REPO = 'Qwen/Qwen2.5-0.5B-Instruct';

const BASE_DETAIL: HfModelDetail = {
  id: REPO,
  revision: 'a'.repeat(40),
  gated: false,
  downloads: 279_396,
  likes: 152,
  license: 'apache-2.0',
  parameters: 630_200_000,
  architecture: 'qwen2',
  contextLength: 8192,
  tools: false,
  vision: false,
  quants: [],
};

/** Every rendered text node and the accessibility label of every labelled row. */
async function renderSummary(
  contextLength: number | undefined,
  language: string
): Promise<{ labels: string[]; text: string[] }> {
  await i18n.changeLanguage(language);
  detail.current = { ...BASE_DETAIL, contextLength };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(() => {
    renderer = TestRenderer.create(
      createElement(ModelCatalogDetailScreen, { id: REPO, key: language })
    );
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  const text = renderer.root
    .findAllByType('Text')
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
  const labels = renderer.root
    .findAll(node => typeof node.props.accessibilityLabel === 'string')
    .map(node => node.props.accessibilityLabel as string);
  renderer.unmount();
  return { labels, text };
}

describe('ModelCatalogDetailScreen summary numbers', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  // Compact notation drops grouping below 10 000, so the ungrouped 8192 sat
  // beside the grouped download count in German.
  it.each([
    [8192, 'Kontextfenster: 8.192'],
    [131_072, 'Kontextfenster: 131.072'],
  ])('groups the %i-token context window in German', async (contextLength, expected) => {
    const { text } = await renderSummary(contextLength, 'de');

    expect(text).toContain(expected);
  });

  it('groups the context window in English too', async () => {
    const { text } = await renderSummary(8192, 'en');

    expect(text).toContain('Context window: 8,192');
  });

  // The popularity counts stay abbreviated: English keeps its short form.
  it('keeps the approximate counts compact', async () => {
    const { labels, text } = await renderSummary(8192, 'en');

    expect(labels).toContain('Downloads: 279.4K');
    expect(labels).toContain('Parameters: 630.2M');
    expect(labels).toContain('Likes: 152');
    expect(text).toContain('279.4K');
  });

  it('omits the context window when the repository states none', async () => {
    const { text } = await renderSummary(undefined, 'de');

    expect(text.some(node => node.startsWith('Kontextfenster:'))).toBe(false);
  });
});
