import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { PersonalCreditsLinks } from './credits-links';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const links = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
const rows = vi.hoisted(() => ({
  rendered: [] as { title: string; subtitle?: string; onPress?: () => void }[],
}));

vi.mock('@/lib/external-link', () => ({ openExternalUrl: links.openExternalUrl }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://kilo.test' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: navigation.push }) }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/icons', () => ({
  FileText: 'FileText',
  Receipt: 'Receipt',
}));
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title: string; subtitle?: string; onPress?: () => void }) => {
    rows.rendered.push(props);
    return null;
  },
}));

async function renderLinks(): Promise<void> {
  await renderWithProviders(createElement(PersonalCreditsLinks));
}

afterEach(() => {
  rows.rendered = [];
  navigation.push.mockClear();
  links.openExternalUrl.mockClear();
});

describe('PersonalCreditsLinks', () => {
  it('opens the personal credit screens from their rows', async () => {
    await renderLinks();

    const historyRow = rows.rendered.find(entry => entry.title === 'Credit history');
    const invoicesRow = rows.rendered.find(entry => entry.title === 'Invoices');
    expect(historyRow).toBeDefined();
    expect(invoicesRow).toBeDefined();

    act(() => {
      historyRow?.onPress?.();
      invoicesRow?.onPress?.();
    });
    expect(navigation.push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/credit-history');
    expect(navigation.push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/invoices');
  });

  it('offers no web billing destination: personal credits are bought in the app', async () => {
    await renderLinks();

    expect(rows.rendered.map(row => row.title)).toEqual(['Credit history', 'Invoices']);
    expect(links.openExternalUrl).not.toHaveBeenCalled();
  });
});
