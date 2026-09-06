import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { TabScreenScrollView } from './tab-screen';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 34 }),
}));

describe('TabScreenScrollView', () => {
  it('reserves the tab bar and final gap outside the scroll viewport', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(TabScreenScrollView, null, createElement('Content'))
    );
    const findByType = (type: string) =>
      renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);

    expect(findByType('ScrollView')[0]?.props.style).toEqual([undefined, { marginBottom: 100 }]);
    expect(findByType('View')).toHaveLength(0);
    unmount();
  });
});
