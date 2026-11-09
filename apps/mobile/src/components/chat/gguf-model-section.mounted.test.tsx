import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  type GgufDownload,
  type GgufDownloadsSnapshot,
  type GgufModelRecord,
} from '@/lib/chat/gguf-records';
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

const FILE_ID = 'q2_k-file';
const RECORD: GgufModelRecord = {
  fileId: FILE_ID,
  name: 'Qwen2.5 0.5B Instruct',
  url: 'https://example.com/model.gguf',
  sizeBytes: 1_000,
  contextWindow: 8_192,
  tools: true,
  vision: false,
  thinking: false,
};
const PAUSED: GgufDownload = {
  fileId: FILE_ID,
  name: 'Qwen2.5 0.5B Instruct',
  phase: 'paused',
  pending: false,
  written: 250,
  total: 1_000,
};

let view: RenderWithProvidersResult | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

type RenderedControl = { label: string | undefined; visible: string; disabled: boolean };

/** Mount one row's controls and read every button's name and rendered text. */
async function mountRow(
  snapshot: GgufDownloadsSnapshot,
  downloadDetail?: string
): Promise<RenderedControl[]> {
  view?.unmount();
  view = await renderWithProviders(
    createElement(GgufDownloadControls, {
      fileId: FILE_ID,
      name: 'Qwen2.5 0.5B Instruct',
      snapshot,
      onDownload: () => undefined,
      ...(downloadDetail === undefined ? {} : { downloadDetail }),
    })
  );
  return view.renderer.root
    .findAll(node => (node.type as string) === 'Button')
    .map(button => ({
      label: button.props.accessibilityLabel as string | undefined,
      visible: button.find(node => (node.type as string) === 'Text').props.children as string,
      disabled: button.props.disabled === true,
    }));
}

describe('the model row control names', () => {
  it('starts the download name with the visible label and adds the row detail', async () => {
    const [download] = await mountRow({ models: [], download: null, failure: null }, 'q2_k');

    expect(download?.visible).not.toBe('');
    expect(download?.label?.startsWith(download.visible)).toBe(true);
    expect(download?.label).toContain('q2_k');
  });

  it('uses the row detail on the delete and transfer controls too', async () => {
    const downloaded = await mountRow({ models: [RECORD], download: null, failure: null }, 'q2_k');
    const transferring = await mountRow({ models: [], download: PAUSED, failure: null }, 'q2_k');

    expect([...downloaded, ...transferring]).toHaveLength(3);
    for (const control of [...downloaded, ...transferring]) {
      expect(control.label?.startsWith(control.visible)).toBe(true);
      expect(control.label).toContain('q2_k');
    }
  });

  it('leaves the name to the visible text when no detail distinguishes the row', async () => {
    const controls = await mountRow({ models: [RECORD], download: null, failure: null });

    expect(controls).toHaveLength(1);
    expect(controls[0]?.label).toBeUndefined();
    expect(controls[0]?.visible).not.toBe('');
  });

  it('ignores a blank detail instead of naming the control with empty brackets', async () => {
    const controls = await mountRow({ models: [], download: null, failure: null }, '   ');

    expect(controls[0]?.label).toBeUndefined();
    expect(controls[0]?.visible).not.toBe('');
  });

  it('spends the pause button while a pause is in flight and leaves Cancel live', async () => {
    const controls = await mountRow({
      models: [],
      download: { ...PAUSED, pending: true },
      failure: null,
    });

    expect(controls.map(control => control.disabled)).toEqual([true, false]);
  });
});
