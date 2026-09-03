import {
  MONTHLY_USAGE_COLUMNS,
  monthlyUsageToTsv,
  type MonthlyUsageRow,
} from './monthly-usage-export';

const row: MonthlyUsageRow = {
  provider: 'openrouter',
  is_byok: false,
  users: '123',
  logged_in_users: '100',
  input_tokens: '9007199254740993',
  output_tokens: '200',
  cache_read_tokens: '300',
  cache_write_tokens: '400',
  cost: '1234567.890123',
  market_cost: '7654321.123456',
};

describe('monthlyUsageToTsv', () => {
  it('copies column headers and exact numeric values without formatting or rounding', () => {
    expect(monthlyUsageToTsv([row])).toBe(
      `${MONTHLY_USAGE_COLUMNS.join('\t')}\nopenrouter\tfalse\t123\t100\t9007199254740993\t200\t300\t400\t1234567.890123\t7654321.123456`
    );
  });

  it('preserves true BYOK and negative costs as spreadsheet values', () => {
    expect(monthlyUsageToTsv([{ ...row, is_byok: true, cost: '-1.25' }]).split('\n')[1]).toBe(
      'openrouter\ttrue\t123\t100\t9007199254740993\t200\t300\t400\t-1.25\t7654321.123456'
    );
  });

  it('copies nullable values as empty cells, not zeros', () => {
    expect(
      monthlyUsageToTsv([
        { ...row, provider: null, is_byok: null, input_tokens: null, market_cost: null },
      ]).split('\n')[1]
    ).toBe('\t\t123\t100\t\t200\t300\t400\t1234567.890123\t');
  });

  it.each(['=SUM(1,2)', '+1', '-1', '@SUM(1)', '  =SUM(1)'])(
    'neutralizes provider spreadsheet formulas: %s',
    provider => {
      expect(
        monthlyUsageToTsv([{ ...row, provider }])
          .split('\n')[1]
          .split('\t')[0]
      ).toBe(`'${provider}`);
    }
  );

  it('keeps provider tabs and line breaks from creating extra rows or cells', () => {
    const tsv = monthlyUsageToTsv([{ ...row, provider: '\t=SUM(1)\r\nprovider' }]);
    expect(tsv.split('\n')).toHaveLength(2);
    expect(tsv.split('\n')[1].split('\t')).toHaveLength(MONTHLY_USAGE_COLUMNS.length);
    expect(tsv.split('\n')[1].split('\t')[0]).toBe("' =SUM(1)  provider");
  });

  it('escapes provider quotes using spreadsheet field quoting', () => {
    expect(
      monthlyUsageToTsv([{ ...row, provider: 'a "quoted" provider' }])
        .split('\n')[1]
        .split('\t')[0]
    ).toBe('"a ""quoted"" provider"');
  });

  it('returns only headers for empty results', () => {
    expect(monthlyUsageToTsv([])).toBe(MONTHLY_USAGE_COLUMNS.join('\t'));
  });
});
