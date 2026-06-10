import {
  assertNotNullish,
  toNonNullish,
  parseResultJsonWithZodSchema,
  formatIsoDateString_UsaDateOnlyFormat,
  isDateOnlyString,
} from './utils';
import * as z from 'zod';

describe('assertNotNull', () => {
  it('should not throw when value is not null or undefined', () => {
    expect(() => assertNotNullish('hello world')).not.toThrow();
    expect(() => assertNotNullish(42)).not.toThrow();
    expect(() => assertNotNullish({ key: 'value' })).not.toThrow();
    expect(() => assertNotNullish([1, 2, 3])).not.toThrow();
    expect(() => assertNotNullish(0)).not.toThrow();
    expect(() => assertNotNullish('')).not.toThrow();
    expect(() => assertNotNullish(false)).not.toThrow();
  });

  it('should throw a custom error message when provided', () => {
    expect(() => assertNotNullish(undefined)).toThrow('Value must not be null or undefined');
    expect(() => assertNotNullish(null)).toThrow('Value must not be null or undefined');
    const customMessage = 'Custom error message';
    expect(() => assertNotNullish(null, customMessage)).toThrow(customMessage);
    expect(() => assertNotNullish(undefined, customMessage)).toThrow(customMessage);
  });

  it('should properly narrow types (compile-time test)', () => {
    // This test verifies TypeScript type narrowing works correctly
    const nullableString: string | null = 'test';
    const nullableNumber: number | undefined = 42;

    // After assertNotNull, TypeScript should know these are not null/undefined
    assertNotNullish(nullableString);
    assertNotNullish(nullableNumber);

    // These should work without type errors after assertion
    expect(nullableString.toUpperCase()).toBe('TEST');
    expect(nullableNumber.toFixed(2)).toBe('42.00');
  });
});

describe('parseResultJsonWithZodSchema', () => {
  // Helper to create a mock Response object
  const createMockResponse = (
    status: number,
    statusText: string,
    jsonData: unknown,
    shouldJsonFail = false
  ): { response: Response; jsonMock: jest.Mock } => {
    const jsonMock = jest.fn().mockImplementation(() => {
      if (shouldJsonFail) {
        return Promise.reject(new Error('Invalid JSON'));
      }
      return Promise.resolve(jsonData);
    });

    const response = {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: jsonMock,
    } as unknown as Response;

    return { response, jsonMock };
  };

  const testSchema = z.object({
    id: z.number(),
    name: z.string(),
    email: z.email(),
  });

  const validData = {
    id: 1,
    name: 'John Doe',
    email: 'john@example.com',
  };

  it('should successfully parse valid response data', async () => {
    const { response, jsonMock } = createMockResponse(200, 'OK', validData);

    const result = await parseResultJsonWithZodSchema(response, testSchema);

    expect(result).toEqual(validData);
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should throw error when response data fails schema validation', async () => {
    const invalidData = {
      id: '1', // Should be number
      name: 123, // Should be string
      email: 'invalid-email', // Should be valid email
    };

    const { response, jsonMock } = createMockResponse(200, 'OK', invalidData);

    await expect(parseResultJsonWithZodSchema(response, testSchema)).rejects.toThrow();
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should handle error response with JSON error message', async () => {
    const errorData = { error: 'User not found' };
    const { response, jsonMock } = createMockResponse(404, 'Not Found', errorData);

    await expect(parseResultJsonWithZodSchema(response, testSchema)).rejects.toThrow(
      'User not found'
    );
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should handle error response with default message when no error field', async () => {
    const errorData = { message: 'Some other error format' };
    const { response, jsonMock } = createMockResponse(500, 'Internal Server Error', errorData);

    await expect(parseResultJsonWithZodSchema(response, testSchema)).rejects.toThrow(
      'Failed to fetch data: Internal Server Error'
    );
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should handle error response when JSON parsing fails', async () => {
    const { response, jsonMock } = createMockResponse(400, 'Bad Request', null, true);

    await expect(parseResultJsonWithZodSchema(response, testSchema)).rejects.toThrow(
      'Failed to fetch data: Bad Request'
    );
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should handle error response with non-string error field', async () => {
    const errorData = { error: { code: 404, message: 'Not found' } };
    const { response, jsonMock } = createMockResponse(404, 'Not Found', errorData);

    await expect(parseResultJsonWithZodSchema(response, testSchema)).rejects.toThrow(
      'Failed to fetch data: Not Found'
    );
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should handle error response with null error data', async () => {
    const { response, jsonMock } = createMockResponse(500, 'Internal Server Error', null);

    await expect(parseResultJsonWithZodSchema(response, testSchema)).rejects.toThrow(
      'Failed to fetch data: Internal Server Error'
    );
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should work with different schema types', async () => {
    const stringSchema = z.string();
    const { response, jsonMock } = createMockResponse(200, 'OK', 'hello world');

    const result = await parseResultJsonWithZodSchema(response, stringSchema);

    expect(result).toBe('hello world');
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should work with array schema', async () => {
    const arraySchema = z.array(z.number());
    const arrayData = [1, 2, 3, 4, 5];
    const { response, jsonMock } = createMockResponse(200, 'OK', arrayData);

    const result = await parseResultJsonWithZodSchema(response, arraySchema);

    expect(result).toEqual(arrayData);
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('should preserve console.log behavior on JSON parse error', async () => {
    const { response } = createMockResponse(400, 'Bad Request', null, true);

    await expect(parseResultJsonWithZodSchema(response, testSchema)).rejects.toThrow(
      'Failed to fetch data: Bad Request'
    );
  });
});

describe('isDateOnlyString', () => {
  it('accepts YYYY-MM-DD strings', () => {
    expect(isDateOnlyString('2026-04-21')).toBe(true);
    expect(isDateOnlyString('1999-12-31')).toBe(true);
    expect(isDateOnlyString('2026-01-01')).toBe(true);
  });

  it('rejects strings with a time component', () => {
    expect(isDateOnlyString('2026-04-21T00:00:00Z')).toBe(false);
    expect(isDateOnlyString('2026-04-21 13:00:00+00')).toBe(false);
    expect(isDateOnlyString('2026-04-21T13:00:00.000Z')).toBe(false);
  });

  it('rejects malformed date-like strings', () => {
    expect(isDateOnlyString('2026-04')).toBe(false);
    expect(isDateOnlyString('04-21-2026')).toBe(false);
    expect(isDateOnlyString('2026/04/21')).toBe(false);
    expect(isDateOnlyString('2026-4-21')).toBe(false);
    expect(isDateOnlyString('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isDateOnlyString(null)).toBe(false);
    expect(isDateOnlyString(undefined)).toBe(false);
    expect(isDateOnlyString(20260421)).toBe(false);
    expect(isDateOnlyString(new Date())).toBe(false);
    expect(isDateOnlyString({})).toBe(false);
  });
});

describe('formatIsoDateString_UsaDateOnlyFormat', () => {
  it('returns em-dash for null input', () => {
    expect(formatIsoDateString_UsaDateOnlyFormat(null)).toBe('—');
  });

  it('returns em-dash for empty string', () => {
    expect(formatIsoDateString_UsaDateOnlyFormat('')).toBe('—');
  });

  it('formats a date-only string as the UTC calendar day', () => {
    // Regression: a viewer west of UTC would otherwise see "2026-04-21"
    // re-labeled as "Apr 20" because new Date("YYYY-MM-DD") parses as UTC
    // midnight and toLocaleDateString() shifts to local TZ. We force UTC
    // formatting for date-only inputs, so the displayed day must be 21.
    const formatted = formatIsoDateString_UsaDateOnlyFormat('2026-04-21');
    const utcOracle = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date('2026-04-21'));
    expect(formatted).toBe(utcOracle);
    // Sanity assertion that's TZ-agnostic: the UTC day for "2026-04-21" is 21.
    expect(formatted).toContain('Apr');
    expect(formatted).toContain('21');
    expect(formatted).toContain('2026');
  });

  it('formats a full ISO datetime in the viewer local TZ (unchanged behavior)', () => {
    // Full ISO datetimes represent an instant in time (e.g. subscription
    // refill timestamps, DB created_at). Local-TZ rendering is intentional
    // and must not regress.
    const input = '2026-04-21T13:00:00.000Z';
    const expected = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(input));
    expect(formatIsoDateString_UsaDateOnlyFormat(input)).toBe(expected);
  });

  it('formats Date object input in the viewer local TZ (unchanged behavior)', () => {
    const date = new Date('2026-04-21T12:00:00.000Z');
    const expected = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
    expect(formatIsoDateString_UsaDateOnlyFormat(date)).toBe(expected);
  });

  it('returns em-dash for malformed string inputs', () => {
    // Regression: previously fell through to toLocaleDateString which emits
    // the literal "Invalid Date" for malformed inputs.
    expect(formatIsoDateString_UsaDateOnlyFormat('not-a-date')).toBe('—');
    expect(formatIsoDateString_UsaDateOnlyFormat('2026-13-45')).toBe('—');
  });

  it('returns em-dash for an Invalid Date object', () => {
    expect(formatIsoDateString_UsaDateOnlyFormat(new Date('invalid'))).toBe('—');
  });
});

describe('requireNotNull', () => {
  it('should return the value when it is not null or undefined', () => {
    expect(toNonNullish('hello world')).toBe('hello world');
    expect(toNonNullish(0)).toBe(0);
  });

  it('should throw an error when value is null or undefined', () => {
    expect(() => toNonNullish(null)).toThrow('Value must not be null or undefined');
    expect(() => toNonNullish(undefined)).toThrow('Value must not be null or undefined');
    expect(() => toNonNullish(null, 'FOO')).toThrow('FOO');
    expect(() => toNonNullish(undefined, 'FOO')).toThrow('FOO');
  });

  it('should properly narrow return type (compile-time test)', () => {
    const nullableString: string | null = 'test';
    const nullableNumber: number | undefined = 42;

    expect(toNonNullish(nullableString).toUpperCase()).toBe('TEST');
    expect(toNonNullish(nullableNumber).toFixed(2)).toBe('42.00');
  });
});
