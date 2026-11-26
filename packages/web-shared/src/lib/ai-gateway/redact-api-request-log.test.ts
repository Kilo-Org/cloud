import { describe, test, expect } from '@jest/globals';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  redactApiRequestLogRequest,
  redactCredentialsInText,
} from '@kilocode/web-shared/lib/ai-gateway/redact-api-request-log';

function redactBody(body: Record<string, unknown>) {
  return redactApiRequestLogRequest({ kind: 'responses', body } as unknown as GatewayRequest);
}

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

  test('redacts the OpenAI Responses MCP tool authorization and headers', () => {
    const tool = {
      type: 'mcp',
      server_label: 'stripe',
      server_url: 'https://mcp.stripe.com',
      authorization: 'sk_live_token',
      headers: { 'X-Api-Key': 'header-key', 'X-Trace': 'trace' },
      require_approval: 'never',
    };

    expect(redactBody({ model: 'openai/gpt-5', tools: [tool] })).toEqual({
      model: 'openai/gpt-5',
      tools: [
        {
          type: 'mcp',
          server_label: 'stripe',
          server_url: 'https://mcp.stripe.com',
          authorization: '[redacted]',
          headers: { 'X-Api-Key': '[redacted]', 'X-Trace': '[redacted]' },
          require_approval: 'never',
        },
      ],
    });
    expect(tool.authorization).toBe('sk_live_token');
    expect(tool.headers['X-Api-Key']).toBe('header-key');
  });

  test('redacts the OpenRouter MCP server tool parameters', () => {
    expect(
      redactBody({
        tools: [
          {
            type: 'openrouter:mcp',
            parameters: {
              server_url: 'https://user:pass@mcp.example.com/sse',
              authorization: 'oauth-token',
              headers: { Cookie: 'session=1' },
            },
          },
        ],
      })
    ).toEqual({
      tools: [
        {
          type: 'openrouter:mcp',
          parameters: {
            server_url: 'https://[redacted]@mcp.example.com/sse',
            authorization: '[redacted]',
            headers: { Cookie: '[redacted]' },
          },
        },
      ],
    });
  });

  test('keeps a headers property in a function tool schema', () => {
    const tool = {
      type: 'function',
      name: 'http_request',
      parameters: {
        type: 'object',
        properties: {
          headers: { type: 'object', description: 'Request headers' },
          password: { type: 'string', description: 'Account password' },
        },
      },
    };

    expect(redactBody({ tools: [tool] })).toEqual({ tools: [tool] });
  });

  test('redacts Anthropic MCP connector and AI SDK MCP server tokens', () => {
    expect(
      redactBody({
        mcp_servers: [
          {
            type: 'url',
            url: 'https://mcp.example.com/sse',
            name: 'example',
            authorization_token: 'anthropic-oauth-token',
          },
        ],
        providerOptions: {
          anthropic: {
            mcpServers: [{ type: 'url', url: 'https://mcp.example.com', authorizationToken: 't' }],
          },
        },
      })
    ).toEqual({
      mcp_servers: [
        {
          type: 'url',
          url: 'https://mcp.example.com/sse',
          name: 'example',
          authorization_token: '[redacted]',
        },
      ],
      providerOptions: {
        anthropic: {
          mcpServers: [
            { type: 'url', url: 'https://mcp.example.com', authorizationToken: '[redacted]' },
          ],
        },
      },
    });
  });

  test('redacts Azure On Your Data authentication options', () => {
    expect(
      redactBody({
        data_sources: [
          {
            type: 'azure_search',
            parameters: {
              endpoint: 'https://search.example.net',
              authentication: { type: 'api_key', key: 'search-key' },
              embedding_dependency: {
                type: 'endpoint',
                authentication: { type: 'access_token', access_token: 'embedding-token' },
              },
            },
          },
          {
            type: 'azure_cosmos_db',
            parameters: {
              authentication: { type: 'connection_string', connection_string: 'AccountKey=x' },
            },
          },
          {
            type: 'elasticsearch',
            parameters: {
              authentication: { type: 'encoded_api_key', encoded_api_key: 'ZW5jb2RlZA==' },
            },
          },
          {
            type: 'mongo_db',
            parameters: {
              authentication: { type: 'username_and_password', username: 'u', password: 'p' },
            },
          },
        ],
      })
    ).toEqual({
      data_sources: [
        {
          type: 'azure_search',
          parameters: {
            endpoint: 'https://search.example.net',
            authentication: { type: 'api_key', key: '[redacted]' },
            embedding_dependency: {
              type: 'endpoint',
              authentication: { type: 'access_token', access_token: '[redacted]' },
            },
          },
        },
        {
          type: 'azure_cosmos_db',
          parameters: {
            authentication: { type: 'connection_string', connection_string: '[redacted]' },
          },
        },
        {
          type: 'elasticsearch',
          parameters: {
            authentication: { type: 'encoded_api_key', encoded_api_key: '[redacted]' },
          },
        },
        {
          type: 'mongo_db',
          parameters: {
            authentication: {
              type: 'username_and_password',
              username: 'u',
              password: '[redacted]',
            },
          },
        },
      ],
    });
  });

  test('redacts LiteLLM per-request provider credentials', () => {
    expect(
      redactBody({
        api_key: 'litellm-key',
        aws_secret_access_key: 'aws-secret',
        aws_session_token: 'aws-session',
        vertex_credentials: '{"private_key":"x"}',
        user_config: {
          model_list: [
            {
              model_name: 'gpt',
              litellm_params: { model: 'azure/gpt', api_key: 'azure-key', api_base: 'https://a' },
            },
          ],
        },
      })
    ).toEqual({
      api_key: '[redacted]',
      aws_secret_access_key: '[redacted]',
      aws_session_token: '[redacted]',
      vertex_credentials: '[redacted]',
      user_config: {
        model_list: [
          {
            model_name: 'gpt',
            litellm_params: { model: 'azure/gpt', api_key: '[redacted]', api_base: 'https://a' },
          },
        ],
      },
    });
  });

  test('redacts arrays and numbers under credential keys and keeps schema objects', () => {
    expect(
      redactBody({
        api_key: ['k1', 'k2'],
        password: 12345,
        secret: null,
        authentication: { type: 'object', properties: { key: { type: 'string' } } },
        byok: { openai: [{ apiKey: 'top-level-byok-is-not-vercel' }] },
      })
    ).toEqual({
      api_key: '[redacted]',
      password: '[redacted]',
      secret: null,
      authentication: { type: 'object', properties: { key: { type: 'string' } } },
      byok: { openai: [{ apiKey: '[redacted]' }] },
    });
  });

  test('keeps a large base64 image byte-identical', () => {
    const url = `data:image/png;base64,${Buffer.alloc(3_000_000, 'x7/+').toString('base64')}`;
    const body = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: url }] }] };

    expect(redactBody(body)).toEqual(body);
  });

  test('keeps token counts and other non-credential fields', () => {
    const body = {
      model: 'anthropic/claude-sonnet-4.5',
      max_tokens: 1024,
      max_output_tokens: 2048,
      metadata: { user_id: 'user-1', author: 'someone' },
      thinking: { type: 'enabled', budget_tokens: 512 },
      stream: true,
    };

    expect(redactBody(body)).toEqual(body);
  });

  test('redacts credentials in message text, tool call arguments and Responses input', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----';
    expect(
      redactBody({
        messages: [
          { role: 'system', content: 'Use Authorization: Bearer sk-abc.def_123' },
          {
            role: 'user',
            content: [{ type: 'text', text: `my key:\n${pem}\nthanks` }],
          },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'shell',
                  arguments:
                    '{"command":"git clone https://x-access-token:ghp_abc@github.com/o/r"}',
                },
              },
            ],
          },
        ],
        input: [{ role: 'user', content: 'fetch https://example.com/v1?key=AIzaSecret&q=1' }],
      })
    ).toEqual({
      messages: [
        { role: 'system', content: 'Use Authorization: Bearer [redacted]' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'my key:\n-----BEGIN RSA PRIVATE KEY-----[redacted]-----END RSA PRIVATE KEY-----\nthanks',
            },
          ],
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'shell',
                arguments: '{"command":"git clone https://[redacted]@github.com/o/r"}',
              },
            },
          ],
        },
      ],
      input: [{ role: 'user', content: 'fetch https://example.com/v1?key=[redacted]&q=1' }],
    });
  });
});

describe('redactCredentialsInText', () => {
  test.each([
    [
      'Bearer token in a JSON header',
      '{"Authorization":"Bearer abc.def-ghi="}',
      '{"Authorization":"Bearer [redacted]"}',
    ],
    [
      'URL with user and password',
      'postgres://admin:hunter2@db:5432/app',
      'postgres://[redacted]@db:5432/app',
    ],
    [
      'URL with a user only',
      'https://ghp_token@github.com/o/r.git',
      'https://[redacted]@github.com/o/r.git',
    ],
    [
      'presigned URL query parameters',
      'https://s3.amazonaws.com/b/k?X-Amz-Credential=AKIA%2F&X-Amz-Signature=abc123',
      'https://s3.amazonaws.com/b/k?X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted]',
    ],
    [
      'OpenSSH private key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r\n-----END OPENSSH PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----[redacted]-----END OPENSSH PRIVATE KEY-----',
    ],
    [
      'PGP private key block',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----[redacted]-----END PGP PRIVATE KEY BLOCK-----',
    ],
    [
      'truncated private key',
      'key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg',
      'key:\n-----BEGIN PRIVATE KEY-----[redacted]',
    ],
    [
      'private key with a mismatched END line',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----',
    ],
    [
      'Basic authorization header',
      'curl -H "Authorization: Basic dXNlcjpwYXNz" https://x',
      'curl -H "Authorization: Basic [redacted]" https://x',
    ],
    [
      'URL fragment token and a markdown link',
      '[cb](https://x/cb#access_token=abc123) and [d](https://x/a?key=abc)',
      '[cb](https://x/cb#access_token=[redacted]) and [d](https://x/a?key=[redacted])',
    ],
    [
      'set of well-known token formats',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789 AWS=AKIAIOSFODNN7EXAMPLE G=AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
      'OPENAI_API_KEY=[redacted] GH=[redacted] AWS=[redacted] G=[redacted]',
    ],
  ])('redacts a %s', (_name, text, expected) => {
    expect(redactCredentialsInText(text)).toBe(expected);
  });

  test.each([
    'an email such as user@example.com',
    'a URL path with an at sign: https://example.com/@user/posts?page=2',
    '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----',
    'set max_tokens=100 and the password policy',
    'a code comment // TODO',
    'prose such as the Bearer of bad news\nand a Bearer authentication scheme',
  ])('keeps %s', text => {
    expect(redactCredentialsInText(text)).toBe(text);
  });

  test.each([
    ['dotted words', 'a.'.repeat(100_000)],
    ['unterminated private key markers', '-----BEGIN PRIVATE KEY-----'.repeat(50_000)],
    ['URL-like prefixes', 'ab://'.repeat(100_000)],
  ])('stays fast on %s', (_name, text) => {
    const start = performance.now();
    redactCredentialsInText(text);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
