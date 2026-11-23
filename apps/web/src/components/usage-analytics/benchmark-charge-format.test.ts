/**
 * The benchmark-charges cost format.
 *
 * Benchmark requests routinely cost fractions of a cent (the connected fixture
 * charged 184 microdollars per request), so the card must not use a fixed
 * 2-decimal money format that renders every row as $0.00 — and must not use a
 * fixed 6-decimal format that renders an ordinary amount as $5.000000.
 * `formatMicrodollarsAdaptive` is the one shared rule for both cases.
 */
import { formatMicrodollarsAdaptive } from '@/lib/admin-utils';

describe('formatMicrodollarsAdaptive', () => {
  it('keeps the familiar two decimals for an ordinary amount', () => {
    expect(formatMicrodollarsAdaptive(5_000_000)).toBe('$5.00');
    expect(formatMicrodollarsAdaptive(1_250_000)).toBe('$1.25');
    expect(formatMicrodollarsAdaptive(0)).toBe('$0.00');
  });

  it('reveals the real sub-cent charge instead of collapsing it to $0.00', () => {
    // The exact measured value of one benchmark request in the connected
    // fixture: 184 microdollars. A fixed 2-decimal format shows $0.00 here.
    expect(formatMicrodollarsAdaptive(184)).toBe('$0.000184');
    // A two-request pool total from the same fixture run.
    expect(formatMicrodollarsAdaptive(368)).toBe('$0.000368');
  });

  it('does not pad an ordinary amount out to six decimals', () => {
    expect(formatMicrodollarsAdaptive(5_000_000)).not.toContain('$5.000000');
  });
});
