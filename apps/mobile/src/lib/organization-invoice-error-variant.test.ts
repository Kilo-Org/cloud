import { describe, expect, it } from 'vitest';

import { selectInvoiceErrorVariant } from '@/lib/organization-invoice-error-variant';

describe('selectInvoiceErrorVariant', () => {
  it('keeps a permanent code ahead of connectivity', () => {
    expect(selectInvoiceErrorVariant('NOT_FOUND', 'offline')).toBe('not-found');
    expect(selectInvoiceErrorVariant('FORBIDDEN', 'offline')).toBe('permission');
    expect(selectInvoiceErrorVariant('UNAUTHORIZED', 'online')).toBe('permission');
  });

  it('presents a confirmed-offline failure as connectivity', () => {
    expect(selectInvoiceErrorVariant(undefined, 'offline')).toBe('offline');
  });

  it('keeps the retryable neutral state when connectivity is unknown or online', () => {
    expect(selectInvoiceErrorVariant(undefined, 'unknown')).toBe('neutral');
    expect(selectInvoiceErrorVariant(undefined, 'online')).toBe('neutral');
    expect(selectInvoiceErrorVariant('INTERNAL_SERVER_ERROR', 'online')).toBe('neutral');
  });
});
