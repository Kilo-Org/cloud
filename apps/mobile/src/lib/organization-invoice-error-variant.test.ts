import { RequestDeadlineError } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import { selectInvoiceErrorVariant } from '@/lib/organization-invoice-error-variant';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

describe('selectInvoiceErrorVariant', () => {
  it('keeps a permanent code ahead of connectivity', () => {
    expect(selectInvoiceErrorVariant(makeTrpcError('NOT_FOUND'), 'offline')).toBe('not-found');
    expect(selectInvoiceErrorVariant(makeTrpcError('FORBIDDEN'), 'offline')).toBe('permission');
    expect(selectInvoiceErrorVariant(makeTrpcError('UNAUTHORIZED'), 'online')).toBe('permission');
  });

  it('presents a confirmed-offline failure as connectivity', () => {
    expect(selectInvoiceErrorVariant(undefined, 'offline')).toBe('offline');
    expect(selectInvoiceErrorVariant(new Error('network down'), 'offline')).toBe('offline');
  });

  it('names a deadline abort as the retryable slow-response state', () => {
    expect(selectInvoiceErrorVariant(new RequestDeadlineError(15_000), 'online')).toBe('timeout');
    expect(selectInvoiceErrorVariant(new RequestDeadlineError(15_000), 'unknown')).toBe('timeout');
  });

  it('keeps the retryable neutral state when connectivity is unknown or online', () => {
    expect(selectInvoiceErrorVariant(undefined, 'unknown')).toBe('neutral');
    expect(selectInvoiceErrorVariant(undefined, 'online')).toBe('neutral');
    expect(selectInvoiceErrorVariant(makeTrpcError('INTERNAL_SERVER_ERROR'), 'online')).toBe(
      'neutral'
    );
  });
});
