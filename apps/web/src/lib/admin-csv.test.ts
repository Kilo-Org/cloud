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
  it('quotes values with commas, quotes, or line breaks and doubles embedded quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('first\nsecond')).toBe('"first\nsecond"');
    expect(csvField('first\rsecond')).toBe('"first\rsecond"');
    expect(csvField('first\r\nsecond')).toBe('"first\r\nsecond"');
  });

  it('leaves a plain value unquoted', () => {
    expect(csvField('plain')).toBe('plain');
  });

  it('prefixes before quoting so the prefix stays inside the quotes', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('=SUM(A1,B1)')).toBe(`"'=SUM(A1,B1)"`);
  });
});
