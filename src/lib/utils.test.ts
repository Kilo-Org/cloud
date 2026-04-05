import { assertNotNullish, toNonNullish, parseResultJsonWithZodSchema } from './utils';
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
