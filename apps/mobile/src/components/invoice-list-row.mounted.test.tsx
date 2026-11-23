import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';

import { type Invoice, InvoiceRow } from './invoice-list-row';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Download: 'Download' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#71717a' }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
// `@/lib/invoice-download` stays real, so a row's no-PDF decision is the app's
// own; only the two native modules behind a share are stubbed here.
vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: Object.assign(vi.fn(), { downloadFileAsync: vi.fn() }),
  Paths: { cache: 'file:///cache' },
}));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));

/** One invoice in the shape both scopes return. */
function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'in_1',
    number: 'KL-0001',
    status: 'paid',
    amount_due: 1200,
    currency: 'usd',
    created: 1_791_000_000,
    hosted_invoice_url: null,
    invoice_pdf: 'https://stripe.example.test/invoice/1.pdf',
    ...overrides,
  };
}

async function render(row: Invoice) {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(
      createElement(InvoiceRow, { invoice: row }) as ReactElement
    );
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

/** Every string the row paints, so a fact the row drops is visible to a test. */
function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  const collected: string[] = [];
  const walk = (instance: TestRenderer.ReactTestInstance): void => {
    for (const child of instance.children) {
      if (typeof child === 'string') {
        collected.push(child);
      } else if (typeof child !== 'number') {
        walk(child);
      }
    }
  };
  walk(renderer.root);
  return collected;
}

// The amount carries a bidi isolate and some locales a no-break space; these
// assertions are about the facts, not that carriage.
function readable(text: string): string {
  return text.replaceAll(/[\u2066\u2068\u2069]/g, '').replaceAll('\u00A0', ' ');
}

/** The facts the row paints, read off the screen it paints them on. */
function paintedFacts(renderer: TestRenderer.ReactTestRenderer): {
  title: string;
  amount: string;
  date: string;
  status: string;
} {
  const painted = texts(renderer).map(text => readable(text));
  const amountIndex = painted.findIndex(text => text.startsWith('$'));
  const title = painted.at(0);
  const amount = painted.at(amountIndex);
  const date = painted.at(amountIndex + 1);
  const status = painted.at(-1);
  if (
    title === undefined ||
    amount === undefined ||
    date === undefined ||
    status === undefined ||
    amountIndex === -1
  ) {
    throw new Error('The row did not paint a title, an amount, a date and a status');
  }
  return { title, amount, date, status };
}

/** The row's accessible name, which is the whole row's own pressable. */
function rowLabelOf(renderer: TestRenderer.ReactTestRenderer): string {
  const pressables = renderer.root.findAll(node => String(node.type) === 'Pressable');
  expect(pressables).toHaveLength(1);
  return readable(String(pressables[0]?.props.accessibilityLabel));
}

describe('InvoiceRow', () => {
  it('names the download with the invoice, amount, date and status it paints', async () => {
    const renderer = await render(invoice());

    const facts = paintedFacts(renderer);
    const label = rowLabelOf(renderer);
    // The name is the row's only spoken content: the amount, date and status are
    // children of the button, so a name without them leaves the reader unable
    // to tell two invoices apart.
    expect(label).toContain(facts.title);
    expect(label).toContain(facts.amount);
    expect(label).toContain(facts.date);
    expect(label).toContain(facts.status);
    renderer.unmount();
  });

  it('names two invoices differently when only their amount, date and status differ', async () => {
    const earlier = await render(invoice());
    const later = await render(
      invoice({
        id: 'in_2',
        amount_due: 4900,
        created: 1_792_000_000,
        status: 'open',
      })
    );

    const earlierFacts = paintedFacts(earlier);
    const laterFacts = paintedFacts(later);
    const earlierLabel = rowLabelOf(earlier);
    const laterLabel = rowLabelOf(later);

    expect(earlierLabel).not.toBe(laterLabel);
    expect(earlierLabel).toContain(earlierFacts.amount);
    expect(laterLabel).toContain(laterFacts.amount);
    expect(laterLabel).toContain(laterFacts.status);

    earlier.unmount();
    later.unmount();
  });

  it('keeps a row with no PDF a plain set of facts', async () => {
    const renderer = await render(invoice({ invoice_pdf: null }));

    expect(renderer.root.findAll(node => String(node.type) === 'Pressable')).toHaveLength(0);
    const facts = paintedFacts(renderer);
    // Nothing is a button here, so each fact keeps its own node instead of
    // folding into one spoken sentence.
    expect(facts.title).toBe('KL-0001');
    expect(facts.date.length).toBeGreaterThan(0);
    expect(facts.status.length).toBeGreaterThan(0);
    renderer.unmount();
  });
});

describe('InvoiceRow in the reader language', () => {
  it('names the download in Arabic with the amount the row paints', async () => {
    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      const renderer = await render(invoice());

      const facts = paintedFacts(renderer);
      const label = rowLabelOf(renderer);
      // The frame comes from ar.json's own sentence, so a fallback to the
      // English name cannot pass, and the amount is the one on screen.
      expect(label).toContain('تنزيل الفاتورة');
      expect(label).toContain(facts.amount);
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });
});
