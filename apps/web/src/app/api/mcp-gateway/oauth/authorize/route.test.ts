import { describe, expect, test } from '@jest/globals';
import { OAuthAuthorizationQuerySchema, parseScopedConnectPath } from '@kilocode/mcp-gateway';
import { authorizationExecutionContext } from './route';

describe('authorizationExecutionContext', () => {
  test('uses the org context from a requested org resource', () => {
    const route = parseScopedConnectPath(
      '/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc'
    );
    if (!route) throw new Error('Expected org route');
    const query = OAuthAuthorizationQuerySchema.parse({
      client_id: 'mcp:client',
      redirect_uri: 'http://127.0.0.1:60424/callback',
      response_type: 'code',
      resource:
        'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
    });

    expect(
      authorizationExecutionContext({
        query,
        defaultExecutionContext: { type: 'personal' },
        parseResource: () => route,
      })
    ).toEqual({ type: 'organization', organizationId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f' });
  });

  test('keeps personal context for a requested personal resource', () => {
    const route = parseScopedConnectPath(
      '/mcp-connect/user/b67e423d-8d74-457e-9236-3c5997f7d9d4/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc'
    );
    if (!route) throw new Error('Expected personal route');
    const query = OAuthAuthorizationQuerySchema.parse({
      client_id: 'mcp:client',
      redirect_uri: 'http://127.0.0.1:60424/callback',
      response_type: 'code',
      resource:
        'http://localhost:8806/mcp-connect/user/b67e423d-8d74-457e-9236-3c5997f7d9d4/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
    });

    expect(
      authorizationExecutionContext({
        query,
        defaultExecutionContext: {
          type: 'organization',
          organizationId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
        },
        parseResource: () => route,
      })
    ).toEqual({ type: 'personal' });
  });
});
