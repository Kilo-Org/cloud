import { describe, expect, it } from '@jest/globals';
import { csvField } from '@/lib/admin-csv';

describe('csvField', () => {
  it('keeps quoting for commas, quotes and line breaks', () => {
    expect(csvField('')).toBe('');
    expect(csvField('plain text')).toBe('plain text');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('line one\rline two')).toBe('"line one\rline two"');
  });

  it('formats representative cells as literal text', () => {
    const cases: Array<[string, string]> = [
      ['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
      ['+1', `'+1`],
      ['-1', `'-1`],
      ['@SUM(1)', `'@SUM(1)`],
      ['\t=1+1', `'\t=1+1`],
      ['\r=1', `"'\r=1"`],
      ['  =1', `'  =1`],
      [' =1,2', `"' =1,2"`],
    ];

    for (const [value, expected] of cases) {
      expect([value, csvField(value)]).toEqual([value, expected]);
    }
  });

  it('leaves already prefixed and plain values untouched', () => {
    expect(csvField("'=1")).toBe("'=1");
    expect(csvField('user@example.com')).toBe('user@example.com');
    expect(csvField('2026-10-02 11:22:33')).toBe('2026-10-02 11:22:33');
  });

  it('composes a row where no cell opens with an active leading character', () => {
    const row = ['=1', '+1', '-1', '@1', '\t1'].map(csvField).join(',');
    const cells = row.split(',');
    expect(cells).toHaveLength(5);
    for (const cell of cells) expect(cell.startsWith("'")).toBe(true);
  });
});
