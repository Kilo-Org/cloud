import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { PersonalCreditsLinks } from './credits-links';

const gate = vi.hoisted(() => ({ allowed: true }));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const links = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
const rows = vi.hoisted(() => ({
  rendered: [] as { title: string; subtitle?: string; onPress?: () => void }[],
}));

vi.mock('@/lib/credits/external-billing-link', () => ({
  canOpenExternalBilling: () => gate.allowed,
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: links.openExternalUrl }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://kilo.test' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: navigation.push }) }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/icons', () => ({
  FileText: 'FileText',
  Receipt: 'Receipt',
  Wallet: 'Wallet',
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

function manageBillingRow() {
  const row = rows.rendered.find(entry => entry.title === 'Manage billing on kilo.ai');
  if (!row) {
    throw new Error('manage billing row not rendered');
  }
  return row;
}

afterEach(() => {
  gate.allowed = true;
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

  it('links the billing page where the platform may open it', async () => {
    gate.allowed = true;
    await renderLinks();

    const row = manageBillingRow();
    expect(row.subtitle).toBeUndefined();

    act(() => {
      row.onPress?.();
    });
    expect(links.openExternalUrl).toHaveBeenCalledWith('https://kilo.test/credits', {
      label: 'Manage billing on kilo.ai',
    });
  });

  it('keeps the billing row as plain text on iOS, with no link to press', async () => {
    gate.allowed = false;
    await renderLinks();

    const row = manageBillingRow();
    expect(row.onPress).toBeUndefined();
    expect(row.subtitle).toBe(
      'Payment methods, auto top-up, and billing details are managed on kilo.ai.'
    );
    expect(links.openExternalUrl).not.toHaveBeenCalled();
  });
});
