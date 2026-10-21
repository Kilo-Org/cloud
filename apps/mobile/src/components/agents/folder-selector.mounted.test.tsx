import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TestRenderer } from '@/test/renderer';

import '@/i18n';

import { LaunchFolderField } from './folder-selector';

// The field's value is one line by design so the row keeps its height beside the
// picker chrome; the contract under test is which end of a deep path survives
// that line.
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@/lib/route-registry', () => ({
  folderPickerSlot: { set: vi.fn() },
  UNFENCED_ROUTE_KEY: 'unfenced',
}));

type Instance = TestRenderer.ReactTestInstance;

const INSTANCE = {
  connectionId: 'conn-1',
  name: 'kilowork',
  projectName: 'kilo',
  platform: 'linux',
} as unknown as Parameters<typeof LaunchFolderField>[0]['runOnInstance'];

const DEEP_PATH = 'packages/xmvd7rebw0-حزم-الترجمة/locales/xmvd7rebw0-العربية';

async function mountField(folderPath: string): Promise<TestRenderer.ReactTestRenderer> {
  const renderer = await TestRenderer.act(() =>
    TestRenderer.create(
      createElement(LaunchFolderField, {
        folderPath,
        runOnInstance: INSTANCE,
        onChangeFolderPath: () => {
          // The field only reports the picker's choice; this case never taps.
        },
        disabled: false,
      })
    )
  );
  return renderer;
}

function valueNode(renderer: TestRenderer.ReactTestRenderer): Instance {
  const [row] = renderer.root.findAll(
    candidate => typeof candidate.type === 'string' && (candidate.type as string) === 'Pressable'
  );
  if (!row) {
    throw new Error('the field rendered no picker row');
  }
  const [node] = row.findAll(
    candidate => typeof candidate.type === 'string' && (candidate.type as string) === 'Text'
  );
  if (!node) {
    throw new Error('the picker row rendered no value text');
  }
  return node;
}

describe('LaunchFolderField value', () => {
  it('keeps the end of a deep path so the selected leaf stays readable', async () => {
    const renderer = await mountField(DEEP_PATH);

    // The tail carries the folder the picker confirmed, so a one-line value
    // must give up its middle instead of its end.
    expect(valueNode(renderer).props).toMatchObject({
      numberOfLines: 1,
      ellipsizeMode: 'middle',
      children: DEEP_PATH,
    });

    renderer.unmount();
  });

  it('names the whole path to assistive tech, not the truncated one', async () => {
    const renderer = await mountField(DEEP_PATH);

    const [row] = renderer.root.findAll(
      candidate => typeof candidate.type === 'string' && (candidate.type as string) === 'Pressable'
    );
    expect(row?.props.accessibilityLabel).toBe(`Folder: ${DEEP_PATH}`);

    renderer.unmount();
  });

  it('shows the launch directory name when no folder is confirmed', async () => {
    const renderer = await mountField('');

    expect(valueNode(renderer).props.children).toBe('kilo');

    renderer.unmount();
  });
});
