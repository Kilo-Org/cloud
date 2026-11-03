import { describe, expect, it } from '@jest/globals';
import { csvField, csvLiteral } from '@/lib/admin-csv';

describe('csvLiteral', () => {
  it.each(['=SUM(A1)', '+1', '-1', '@handle'])('prefixes %s', value => {
    expect(csvLiteral(value)).toBe(`'${value}`);
  });

  it('prefixes after leading whitespace', () => {
    expect(csvLiteral(' =SUM(A1)')).toBe("' =SUM(A1)");
    expect(csvLiteral('\tvalue')).toBe("'\tvalue");
    expect(csvLiteral('\rvalue')).toBe("'\rvalue");
  });

  it('leaves ordinary values alone', () => {
    expect(csvLiteral('analyst@example.test')).toBe('analyst@example.test');
    expect(csvLiteral('')).toBe('');
    expect(csvLiteral('a=b')).toBe('a=b');
    expect(csvLiteral('\nvalue')).toBe('\nvalue');
  });
});

describe('csvField', () => {
  it('keeps quoting for commas, quotes and line breaks', () => {
    expect(csvField('')).toBe('');
    expect(csvField('plain text')).toBe('plain text');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('line one\rline two')).toBe('"line one\rline two"');
    expect(csvField('line one\r\nline two')).toBe('"line one\r\nline two"');
    expect(csvField('\nvalue')).toBe('"\nvalue"');
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
      ['=SUM(A1)', "'=SUM(A1)"],
      ['=SUM(A1,B1)', `"'=SUM(A1,B1)"`],
    ];

    for (const [value, expected] of cases) {
      expect([value, csvField(value)]).toEqual([value, expected]);
    }
  });

  it('leaves already prefixed and ordinary values untouched', () => {
    expect(csvField("'=1")).toBe("'=1");
    expect(csvField('user@example.com')).toBe('user@example.com');
    expect(csvField('2026-10-02 11:22:33')).toBe('2026-10-02 11:22:33');
  });
});
