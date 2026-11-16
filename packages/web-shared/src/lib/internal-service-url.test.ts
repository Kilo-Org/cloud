import { describe, expect, test } from '@jest/globals';
import { parseInternalServiceEndpoint, parseInternalServiceUrl } from './internal-service-url';

describe('parseInternalServiceUrl', () => {
  test.each([
    'https://service.example.com/x',
    'http://localhost:3000',
    'http://127.0.0.1:8799',
    'http://[::1]:8787',
  ])('accepts an endpoint value: %s', value => {
    expect(parseInternalServiceUrl(value)).toBeInstanceOf(URL);
  });

  test.each([
    'http://service.example.com',
    'http://10.0.0.5',
    'ftp://service.example.com',
    'service.example.com:3000/x',
    'unix:/tmp/x.sock',
    'not a url',
    '',
  ])('treats a value outside the rule as unconfigured', value => {
    expect(parseInternalServiceUrl(value)).toBeNull();
  });

  test('treats an unset value as unconfigured', () => {
    expect(parseInternalServiceUrl(undefined)).toBeNull();
  });
});

describe('parseInternalServiceEndpoint', () => {
  test('resolves the request path against an accepted endpoint', () => {
    expect(
      parseInternalServiceEndpoint('https://worker.example.com/', '/admin/x')?.toString()
    ).toBe('https://worker.example.com/admin/x');
  });

  test.each(['http://worker.example.com', 'ftp://worker.example.com', '', undefined])(
    'treats the path of a rejected value as unconfigured: %s',
    value => {
      expect(parseInternalServiceEndpoint(value, '/admin/x')).toBeNull();
    }
  );
});
