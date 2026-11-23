/**
 * `CREDIT_EVENT_CLIENT_FIELDS` is maintained by hand, so a new wire field that describes the client
 * must be added to it: otherwise an organization event would publish that field for a gone
 * attributed account.
 */
import { creditEventWireBody, type CreditEvent } from '@kilocode/web-shared/lib/bouncer/client';
import { CREDIT_EVENT_CLIENT_FIELDS } from '@kilocode/web-shared/lib/bouncer/credit-events';

/** Wire keys that do not describe the client. A new one is added here on purpose. */
const NON_CLIENT_WIRE_KEYS: Record<string, true> = {
  eventId: true,
  occurredAt: true,
  userId: true,
  orgId: true,
  type: true,
  flow: true,
  amountCents: true,
  accountCreatedAt: true,
  accountUsedMicrodollars: true,
  disputeId: true,
  provider: true,
  originalTransactionId: true,
  referenceId: true,
  environment: true,
  reason: true,
};

const clientSubject = {
  eventId: 'evt-client-fields',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  userId: 'user-1',
  ip: '203.0.113.7',
  ja4: 't13d1516h2_8daaf6152771_b1ff8ab',
  cardFingerprint: 'card_fingerprint_value',
};

const events: CreditEvent[] = [
  {
    ...clientSubject,
    type: 'charge.attempted',
    flow: 'auto_topup',
    amountCents: 5_000,
    accountCreatedAt: new Date('2025-01-01T00:00:00.000Z'),
    accountUsedMicrodollars: 1_234,
    ipCountry: 'DE',
    cardCountry: 'DE',
  },
  { ...clientSubject, type: 'charge.succeeded', amountCents: 5_000 },
  { ...clientSubject, type: 'charge.failed' },
  { ...clientSubject, type: 'charge.disputed', disputeId: 'dp_client_fields' },
  {
    eventId: 'evt-store-client-fields',
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    userId: 'user-1',
    type: 'store.purchase',
    provider: 'apple',
    referenceId: 'ref_client_fields',
    environment: 'production',
    amountCents: 5_000,
  },
];

describe('CREDIT_EVENT_CLIENT_FIELDS', () => {
  it('covers every wire key that describes the client', () => {
    for (const event of events) {
      const keys = Object.keys(creditEventWireBody(event));
      const unclassified = keys.filter(
        key =>
          !(key in NON_CLIENT_WIRE_KEYS) && !CREDIT_EVENT_CLIENT_FIELDS.some(field => field === key)
      );
      expect({ type: event.type, unclassified }).toEqual({ type: event.type, unclassified: [] });
    }
  });

  it('lists every client field the serializer still emits', () => {
    const attempted = events.find(event => event.type === 'charge.attempted');
    if (!attempted) throw new Error('Missing charge.attempted fixture');
    const keys = Object.keys(creditEventWireBody(attempted));
    const missing = CREDIT_EVENT_CLIENT_FIELDS.filter(field => !keys.includes(field));
    expect(missing).toEqual([]);
  });
});
