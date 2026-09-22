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
vi.mock('@/components/ui/refresh-progress', () => ({ RefreshProgress: 'RefreshProgress' }));

describe('TabScreenScrollView', () => {
  it('ends the viewport at the tab bar top and keeps the final gap inside the content', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(TabScreenScrollView, null, createElement('Content'))
    );
    const findByType = (type: string) =>
      renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
    const scroll = findByType('ScrollView')[0];

    // The bar is 84pt here (50pt base + the 34pt bottom inset), and the viewport
    // must end at its top edge so a section header at the content edge is inset
    // above the bar. Insetting it by the extra 16pt gap cut the dark landscape
    // Home EXPLORE header mid-text 16pt above the bar (landscape spot defect e1).
    expect(scroll?.props.style).toEqual([undefined, { marginBottom: 84 }]);
    // The final gap is breathing room for the last row, so it rides on a
    // trailing spacer inside the scroll content instead of on the viewport.
    const childTypes = scroll?.children.map(child =>
      typeof child === 'string' ? child : child.type
    );
    expect(childTypes).toEqual(['Content', 'View']);
    const [spacer] = findByType('View');
    expect(spacer?.props.style).toEqual({ height: 16 });
    unmount();
  });
});
