import { describe, expect, test } from '@jest/globals';
import { GET } from './route';

describe('GET /api/docs', () => {
  test('renders Swagger UI as read-only without submit controls', async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(body).toContain('supportedSubmitMethods: []');
    expect(body).toContain('tryItOutEnabled: false');
    expect(body).toContain('.swagger-ui .auth-wrapper');
    expect(body).toContain('.swagger-ui .authorization__btn');
    expect(body).toContain('display: none !important');
    expect(body).toContain('Swagger UI generated from the Kilo Code OpenAPI document.');
    expect(body).not.toContain('tRPC OpenAPI document');
  });
});
