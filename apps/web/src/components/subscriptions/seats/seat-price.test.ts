import { formatSeatPrice, getSeatPriceInterval, getSeatPriceLineItems } from './seat-price';

function item(overrides: {
  id: string;
  quantity?: number | null;
  unitAmount?: number | null;
  product?: unknown;
  interval?: string | null;
}) {
  return {
    id: overrides.id,
    quantity: overrides.quantity,
    price: {
      product: overrides.product ?? 'prod_teams',
      unit_amount: overrides.unitAmount,
      recurring: { interval: overrides.interval ?? 'month' },
    },
  };
}

describe('formatSeatPrice', () => {
  test('displays only the recurring seat-item amount for a seat-only subscription', () => {
    expect(
      formatSeatPrice([item({ id: 'si_teams', quantity: 3, unitAmount: 1800 })], 'si_teams')
    ).toBe('$54.00/month');
  });

  test('excludes Kilo Pass and other add-on items from the Teams price', () => {
    expect(
      formatSeatPrice(
        [
          item({ id: 'si_teams', quantity: 3, unitAmount: 1800, product: 'prod_teams' }),
          item({
            id: 'si_pass',
            quantity: 3,
            unitAmount: 4900,
            product: 'prod_kilo_pass',
          }),
        ],
        'si_teams'
      )
    ).toBe('$54.00/month');
  });

  test('sums multiple qualifying seat items that share the paid seat product', () => {
    expect(
      formatSeatPrice(
        [
          item({ id: 'si_paid', quantity: 2, unitAmount: 1800, product: 'prod_teams' }),
          item({ id: 'si_extra', quantity: 1, unitAmount: 1800, product: 'prod_teams' }),
          item({ id: 'si_pass', quantity: 3, unitAmount: 4900, product: 'prod_kilo_pass' }),
        ],
        'si_paid'
      )
    ).toBe('$54.00/month');
  });

  test('treats missing quantity and unit amount as zero', () => {
    expect(
      formatSeatPrice(
        [
          item({ id: 'si_missing_qty', quantity: null, unitAmount: 1800 }),
          item({ id: 'si_missing_amount', quantity: 3, unitAmount: null, product: 'prod_teams' }),
        ],
        'si_missing_qty'
      )
    ).toBe('$0.00/month');
  });

  test('returns a zero monthly price when the paid seat item is missing', () => {
    expect(
      formatSeatPrice(
        [item({ id: 'si_pass', quantity: 3, unitAmount: 4900, product: 'prod_kilo_pass' })],
        null
      )
    ).toBe('$0.00/month');
  });

  test('preserves yearly billing interval from the paid seat item', () => {
    expect(
      formatSeatPrice(
        [item({ id: 'si_teams', quantity: 3, unitAmount: 18000, interval: 'year' })],
        'si_teams'
      )
    ).toBe('$540.00/year');
  });
});

describe('getSeatPriceLineItems', () => {
  test('includes free promotional seats on the same product and skips add-ons', () => {
    const items = [
      item({ id: 'si_paid', quantity: 3, unitAmount: 1800, product: 'prod_teams' }),
      item({ id: 'si_free', quantity: 2, unitAmount: 0, product: 'prod_teams' }),
      item({ id: 'si_pass', quantity: 3, unitAmount: 4900, product: 'prod_kilo_pass' }),
    ];

    expect(getSeatPriceLineItems(items, 'si_paid').map(seatItem => seatItem.id)).toEqual([
      'si_paid',
      'si_free',
    ]);
  });

  test('falls back to only the paid item when its product id is not a string', () => {
    const items = [
      item({ id: 'si_paid', quantity: 3, unitAmount: 1800, product: { id: 'prod_teams' } }),
      item({ id: 'si_other', quantity: 1, unitAmount: 1800, product: 'prod_teams' }),
    ];

    expect(getSeatPriceLineItems(items, 'si_paid').map(seatItem => seatItem.id)).toEqual([
      'si_paid',
    ]);
  });
});

describe('getSeatPriceInterval', () => {
  test('defaults to month when the paid seat item or interval is missing', () => {
    expect(getSeatPriceInterval(null)).toBe('month');
    expect(getSeatPriceInterval(item({ id: 'si_teams', interval: null }))).toBe('month');
  });
});
