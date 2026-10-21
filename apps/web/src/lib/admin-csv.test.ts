import { csvField } from './admin-csv';

describe('csvField', () => {
  it.each([
    ['comma,value', '"comma,value"'],
    ['quote"value', '"quote""value"'],
    ['line\nbreak', '"line\nbreak"'],
    ['carriage\rreturn', '"carriage\rreturn"'],
    ['windows\r\nbreak', '"windows\r\nbreak"'],
    ['plain value', 'plain value'],
    ['', ''],
  ])('renders %j as %j', (value, expected) => {
    expect(csvField(value)).toBe(expected);
  });
});
