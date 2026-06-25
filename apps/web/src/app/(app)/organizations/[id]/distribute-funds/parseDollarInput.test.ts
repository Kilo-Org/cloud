import { parseDollarInput } from './parseDollarInput';

describe('parseDollarInput', () => {
  it('treats empty input as no allocation', () => {
    expect(parseDollarInput('')).toEqual({ microdollars: 0, error: null });
    expect(parseDollarInput('   ')).toEqual({ microdollars: 0, error: null });
  });

  it('treats an explicit zero as no allocation', () => {
    expect(parseDollarInput('0')).toEqual({ microdollars: 0, error: null });
    expect(parseDollarInput('0.00')).toEqual({ microdollars: 0, error: null });
  });

  it('parses whole and fractional dollar amounts to microdollars', () => {
    expect(parseDollarInput('10')).toEqual({ microdollars: 10_000_000, error: null });
    expect(parseDollarInput('10.50')).toEqual({ microdollars: 10_500_000, error: null });
    expect(parseDollarInput('0.01')).toEqual({ microdollars: 10_000, error: null });
    expect(parseDollarInput('.5')).toEqual({ microdollars: 500_000, error: null });
    expect(parseDollarInput('5.')).toEqual({ microdollars: 5_000_000, error: null });
  });

  it('tolerates commas as thousands separators', () => {
    expect(parseDollarInput('1,000')).toEqual({ microdollars: 1_000_000_000, error: null });
    expect(parseDollarInput('1,234.56')).toEqual({ microdollars: 1_234_560_000, error: null });
  });

  it('rejects more than two decimal places', () => {
    expect(parseDollarInput('1.005')).toEqual({
      microdollars: 0,
      error: 'Use at most 2 decimal places',
    });
  });

  it('rejects non-numeric and negative input', () => {
    expect(parseDollarInput('abc')).toEqual({ microdollars: 0, error: 'Enter a valid amount' });
    expect(parseDollarInput('-5')).toEqual({ microdollars: 0, error: 'Enter a valid amount' });
    expect(parseDollarInput('.')).toEqual({ microdollars: 0, error: 'Enter a valid amount' });
    expect(parseDollarInput('1.2.3')).toEqual({
      microdollars: 0,
      error: 'Enter a valid amount',
    });
  });

  it('rejects pathological input that parses to a non-finite number', () => {
    expect(parseDollarInput('9'.repeat(400))).toEqual({
      microdollars: 0,
      error: 'Enter a valid amount',
    });
  });
});
