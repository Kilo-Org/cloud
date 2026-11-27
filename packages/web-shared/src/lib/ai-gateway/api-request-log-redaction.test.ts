import { describe, test, expect } from '@jest/globals';
import { redactApiRequestLogRequest } from '@kilocode/web-shared/lib/ai-gateway/api-request-log-redaction';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

describe('redactApiRequestLogRequest', () => {
  test('replaces gateway BYOK credentials without mutating the upstream request', () => {
    const request = {
      kind: 'chat_completions',
      body: {
        model: 'zai/glm-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        providerOptions: {
          gateway: {
            order: ['friendli', 'novita'],
            byok: {
              friendli: [{ apiKey: 'friendli-managed-key', baseURL: 'https://api.friendli.ai' }],
              bedrock: [
                {
                  accessKeyId: 'AKIAEXAMPLE',
                  secretAccessKey: 'bedrock-secret',
                  region: 'us-east-1',
                },
                { apiKey: 'bedrock-api-key', region: 'us-west-2' },
              ],
            },
          },
          anthropic: { effort: 'high' },
        },
      },
    } satisfies GatewayRequest;

    expect(redactApiRequestLogRequest(request)).toEqual({
      model: 'zai/glm-5.2',
      messages: [{ role: 'user', content: 'hello' }],
      providerOptions: {
        gateway: {
          order: ['friendli', 'novita'],
          byok: {
            friendli: [{ apiKey: '[redacted]' }],
            bedrock: [{ apiKey: '[redacted]' }, { apiKey: '[redacted]' }],
          },
        },
        anthropic: { effort: 'high' },
      },
    });
    expect(request.body.providerOptions.gateway.byok.friendli[0].apiKey).toBe(
      'friendli-managed-key'
    );
    expect(request.body.providerOptions.gateway.byok.bedrock[0]).toMatchObject({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'bedrock-secret',
    });
    expect(request.body.providerOptions.gateway.byok.bedrock[1]).toEqual({
      apiKey: 'bedrock-api-key',
      region: 'us-west-2',
    });
  });

  test('redacts credentials in tool definitions without scrubbing other strings', () => {
    const tools = [
      {
        type: 'mcp',
        server_label: 'github',
        server_url: 'https://mcp.example.com',
        authorization: 'oauth-token',
        headers: { Authorization: 'Bearer header-token', 'X-Api-Key': 'header-key' },
      },
      { type: 'mcp', server_label: 'docs', server_url: 'https://docs.example.com' },
      {
        type: 'openrouter:mcp',
        parameters: {
          server_url: 'https://mcp.example.com',
          authorization: 'openrouter-token',
          headers: { 'X-Token': 'openrouter-header' },
        },
      },
      { type: 'mcp_server', name: 'gemini', headers: { Authorization: 'Bearer gemini' } },
      {
        type: 'shell',
        environment: {
          type: 'container_auto',
          network_policy: {
            type: 'allowlist',
            allowed_domains: ['api.example.com'],
            domain_secrets: [{ domain: 'api.example.com', name: 'API_KEY', value: 'shell-secret' }],
          },
        },
      },
      {
        type: 'function',
        name: 'lookup',
        description: 'authorization: Bearer not-a-structured-credential',
        parameters: { type: 'object', properties: {} },
      },
    ];
    const request = {
      kind: 'responses',
      body: {
        model: 'openai/gpt-5',
        input: 'my key is sk-not-scrubbed',
        tools,
      },
    } as unknown as GatewayRequest;
    const original = structuredClone(request);

    expect(redactApiRequestLogRequest(request)).toEqual({
      model: 'openai/gpt-5',
      input: 'my key is sk-not-scrubbed',
      tools: [
        {
          type: 'mcp',
          server_label: 'github',
          server_url: 'https://mcp.example.com',
          authorization: '[redacted]',
          headers: { Authorization: '[redacted]', 'X-Api-Key': '[redacted]' },
        },
        { type: 'mcp', server_label: 'docs', server_url: 'https://docs.example.com' },
        {
          type: 'openrouter:mcp',
          parameters: {
            server_url: 'https://mcp.example.com',
            authorization: '[redacted]',
            headers: { 'X-Token': '[redacted]' },
          },
        },
        { type: 'mcp_server', name: 'gemini', headers: { Authorization: '[redacted]' } },
        {
          type: 'shell',
          environment: {
            type: 'container_auto',
            network_policy: {
              type: 'allowlist',
              allowed_domains: ['api.example.com'],
              domain_secrets: [{ domain: 'api.example.com', name: 'API_KEY', value: '[redacted]' }],
            },
          },
        },
        tools[5],
      ],
    });
    expect(request).toEqual(original);
  });

  test('redacts Anthropic MCP connector tokens and Azure On Your Data authentication', () => {
    const request = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        mcp_servers: [
          {
            type: 'url',
            url: 'https://mcp.example.com/sse',
            name: 'example',
            authorization_token: 'anthropic-token',
          },
        ],
        data_sources: [
          {
            type: 'azure_search',
            parameters: {
              endpoint: 'https://search.example.com',
              index_name: 'docs',
              authentication: { type: 'api_key', key: 'search-key' },
              embedding_dependency: {
                type: 'endpoint',
                endpoint: 'https://embeddings.example.com',
                authentication: { type: 'api_key', key: 'embedding-key' },
              },
            },
          },
          {
            type: 'elasticsearch',
            parameters: {
              authentication: { type: 'key_and_key_id', key: 'es-key', key_id: 'es-key-id' },
            },
          },
          {
            type: 'mongo_db',
            parameters: {
              authentication: {
                type: 'username_and_password',
                username: 'mongo-user',
                password: 'mongo-password',
              },
            },
          },
          {
            type: 'azure_cosmos_db',
            parameters: {
              authentication: { type: 'connection_string', connection_string: 'AccountKey=x' },
            },
          },
        ],
      },
    } as unknown as GatewayRequest;
    const original = structuredClone(request);

    expect(redactApiRequestLogRequest(request)).toEqual({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hello' }],
      mcp_servers: [
        {
          type: 'url',
          url: 'https://mcp.example.com/sse',
          name: 'example',
          authorization_token: '[redacted]',
        },
      ],
      data_sources: [
        {
          type: 'azure_search',
          parameters: {
            endpoint: 'https://search.example.com',
            index_name: 'docs',
            authentication: { type: 'api_key', key: '[redacted]' },
            embedding_dependency: {
              type: 'endpoint',
              endpoint: 'https://embeddings.example.com',
              authentication: { type: 'api_key', key: '[redacted]' },
            },
          },
        },
        {
          type: 'elasticsearch',
          parameters: {
            authentication: { type: 'key_and_key_id', key: '[redacted]', key_id: '[redacted]' },
          },
        },
        {
          type: 'mongo_db',
          parameters: {
            authentication: {
              type: 'username_and_password',
              username: 'mongo-user',
              password: '[redacted]',
            },
          },
        },
        {
          type: 'azure_cosmos_db',
          parameters: {
            authentication: { type: 'connection_string', connection_string: '[redacted]' },
          },
        },
      ],
    });
    expect(request).toEqual(original);
  });
});
