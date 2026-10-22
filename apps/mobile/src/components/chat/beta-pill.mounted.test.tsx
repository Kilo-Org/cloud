import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { BetaPill } from './beta-pill';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let view: RenderWithProvidersResult | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('the beta pill', () => {
  it('keeps its own size and one line beside a title', async () => {
    view = await renderWithProviders(createElement(BetaPill));

    const pill = view.renderer.root.find(node => (node.type as string) === 'View');
    const label = view.renderer.root.find(node => (node.type as string) === 'Text');
    expect(pill.props.className).toContain('shrink-0');
    expect(pill.props.className).toContain('self-center');
    expect(label.props.numberOfLines).toBe(1);
  });
});
