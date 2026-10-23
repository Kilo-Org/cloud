import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type GgufDownloadsSnapshot } from '@/lib/chat/gguf-records';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import { GgufDownloadControls } from './gguf-model-section';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/icons', () => ({ PackageSearch: 'PackageSearch' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/chat/backend-provider-choices', () => ({
  BackendProviderChoice: 'BackendProviderChoice',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));
vi.mock('@/lib/chat/gguf-models', () => ({
  ggufDownloadActions: { start: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() },
  ggufUrlSource: vi.fn(),
  useGgufModels: () => ({ models: [], download: null, failure: null }),
}));

const IDLE: GgufDownloadsSnapshot = { models: [], download: null, failure: null };

let view: RenderWithProvidersResult | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

/** Mount one download button and return its name and the text it renders. */
async function downloadButton(downloadDetail: string | undefined) {
  view = await renderWithProviders(
    createElement(GgufDownloadControls, {
      fileId: 'q2_k-file',
      name: 'Qwen2.5 0.5B Instruct',
      snapshot: IDLE,
      onDownload: () => undefined,
      ...(downloadDetail === undefined ? {} : { downloadDetail }),
    })
  );
  const button = view.renderer.root.find(node => (node.type as string) === 'Button');
  const text = button.find(node => (node.type as string) === 'Text');
  return {
    label: button.props.accessibilityLabel as string | undefined,
    visible: text.props.children as string,
  };
}

describe('the model download button name', () => {
  it('starts with the visible label and adds the row detail', async () => {
    const { label, visible } = await downloadButton('q2_k');

    expect(visible).not.toBe('');
    expect(label?.startsWith(visible)).toBe(true);
    expect(label).toContain('q2_k');
  });

  it('leaves the name to the visible text when no detail distinguishes the row', async () => {
    const { label, visible } = await downloadButton(undefined);

    expect(label).toBeUndefined();
    expect(visible).not.toBe('');
  });
});
