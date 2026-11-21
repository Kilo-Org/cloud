import { describe, test, expect } from '@jest/globals';
import {
  EmptyFraudDetectionHeaders,
  getFraudDetectionHeaders,
} from '@kilocode/web-shared/lib/fraud-detection-headers';

describe('getFraudDetectionHeaders', () => {
  test('returns null coordinates when both headers are absent', () => {
    const headers = getFraudDetectionHeaders(new Headers());
    expect(headers.http_x_vercel_ip_latitude).toBeNull();
    expect(headers.http_x_vercel_ip_longitude).toBeNull();
  });

  test('parses a positive and a negative decimal coordinate', () => {
    const headers = getFraudDetectionHeaders(
      new Headers({ 'x-vercel-ip-latitude': '37.7749', 'x-vercel-ip-longitude': '-122.4194' })
    );
    expect(headers.http_x_vercel_ip_latitude).toBe(37.7749);
    expect(headers.http_x_vercel_ip_longitude).toBe(-122.4194);
  });

  test('returns null for a coordinate with trailing text', () => {
    const headers = getFraudDetectionHeaders(new Headers({ 'x-vercel-ip-latitude': '12.5x' }));
    expect(headers.http_x_vercel_ip_latitude).toBeNull();
  });

  test('returns null for a coordinate that is not a number', () => {
    const headers = getFraudDetectionHeaders(new Headers({ 'x-vercel-ip-longitude': 'abc' }));
    expect(headers.http_x_vercel_ip_longitude).toBeNull();
  });

  test('returns null for an empty or whitespace-only coordinate', () => {
    const empty = getFraudDetectionHeaders(new Headers({ 'x-vercel-ip-latitude': '' }));
    expect(empty.http_x_vercel_ip_latitude).toBeNull();
    const blank = getFraudDetectionHeaders(new Headers({ 'x-vercel-ip-longitude': '   ' }));
    expect(blank.http_x_vercel_ip_longitude).toBeNull();
  });

  test('returns null for Infinity and NaN', () => {
    const infinite = getFraudDetectionHeaders(new Headers({ 'x-vercel-ip-latitude': 'Infinity' }));
    expect(infinite.http_x_vercel_ip_latitude).toBeNull();
    const notANumber = getFraudDetectionHeaders(new Headers({ 'x-vercel-ip-longitude': 'NaN' }));
    expect(notANumber.http_x_vercel_ip_longitude).toBeNull();
  });

  test('tolerates leading and trailing spaces around a coordinate', () => {
    const headers = getFraudDetectionHeaders(
      new Headers({ 'x-vercel-ip-latitude': ' 37.7749 ' })
    );
    expect(headers.http_x_vercel_ip_latitude).toBe(37.7749);
  });

  test('passes the other header fields through unchanged', () => {
    const headers = getFraudDetectionHeaders(
      new Headers({
        'x-forwarded-for': '203.0.113.7',
        'x-vercel-ip-city': 'San Francisco',
        'x-vercel-ip-country': 'US',
        'x-vercel-ja4-digest': 't13d1516h2_8daaf6152771_b186095e22b6',
        'user-agent': 'test-agent/1.0',
      })
    );
    expect(headers.http_x_forwarded_for).toBe('203.0.113.7');
    expect(headers.http_x_vercel_ip_city).toBe('San Francisco');
    expect(headers.http_x_vercel_ip_country).toBe('US');
    expect(headers.http_x_vercel_ja4_digest).toBe('t13d1516h2_8daaf6152771_b186095e22b6');
    expect(headers.http_user_agent).toBe('test-agent/1.0');
  });

  test('EmptyFraudDetectionHeaders holds null for both coordinates', () => {
    expect(EmptyFraudDetectionHeaders.http_x_vercel_ip_latitude).toBeNull();
    expect(EmptyFraudDetectionHeaders.http_x_vercel_ip_longitude).toBeNull();
  });
});
