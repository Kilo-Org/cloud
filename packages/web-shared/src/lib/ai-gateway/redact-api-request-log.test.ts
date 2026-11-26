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

  test('keeps credential-like names in tool input and metadata', () => {
    const body = {
      model: 'anthropic/claude-sonnet-4.5',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'bake',
              input: {
                cookie: 'oatmeal',
                secret: false,
                password: 12345,
                authorization: 'pending',
                headers: { Accept: 'text/plain' },
                providerOptions: { gateway: { byok: { openai: [{ apiKey: 'not-a-key' }] } } },
              },
            },
          ],
        },
      ],
      metadata: { user_id: 'user-1', api_key_name: 'ci', authentication: { key: 'shift' } },
      tools: [
        {
          name: 'login',
          input_schema: {
            type: 'object',
            properties: { password: { type: 'string' }, headers: { type: 'object' } },
          },
        },
      ],
    };

    expect(redactBody(body)).toEqual(body);
  });

  test('redacts non-string LiteLLM credentials', () => {
    expect(redactBody({ api_key: ['k1', 'k2'], vertex_credentials: { private_key: 'x' } })).toEqual(
      { api_key: '[redacted]', vertex_credentials: '[redacted]' }
    );
  });

  test('keeps base64 attachments byte-identical, including token-shaped runs', () => {
    const data = `iVBORw0KGgo+AKIAIOSFODNN7EXAMPLE+AIzaSyA0123456789012345678901234567890/${Buffer.alloc(
      3_000_000,
      'x7/+'
    ).toString('base64')}`;
    const body = {
      input: [
        {
          role: 'user',
          content: [{ type: 'input_image', image_url: `data:image/png;base64,${data}` }],
        },
      ],
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
        },
      ],
    };

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
          { role: 'system', content: 'Use Authorization: Bearer kilo_0123456789abcdefXYZ' },
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
                  name: 'write',
                  arguments: JSON.stringify({ path: 'id_rsa', content: pem, mode: 384 }),
                },
              },
              {
                id: 'call_2',
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
        input: [
          {
            role: 'user',
            content: 'fetch https://example.com/v1?key=AIzaSyA0123456789abc&q=1',
          },
        ],
      })
    ).toEqual({
      messages: [
        { role: 'system', content: 'Use Authorization: Bearer [redacted]' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'my key:\n-----BEGIN RSA PRIVATE KEY-----\n[redacted]\n-----END RSA PRIVATE KEY-----\nthanks',
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
                name: 'write',
                arguments: JSON.stringify({
                  path: 'id_rsa',
                  content:
                    '-----BEGIN RSA PRIVATE KEY-----\n[redacted]\n-----END RSA PRIVATE KEY-----',
                  mode: 384,
                }),
              },
            },
            {
              id: 'call_2',
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

  test('keeps tool call arguments that mention a PEM header without key material', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'grep',
                arguments: '{"pattern":"-----BEGIN PRIVATE KEY-----", "path":"src/"}',
              },
            },
          ],
        },
      ],
    };

    expect(redactBody(body)).toEqual(body);
  });
});

describe('redactCredentialsInText', () => {
  test.each([
    [
      'Bearer token in a JSON header',
      '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig"}',
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
      'https://s3.amazonaws.com/b/k?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261126&X-Amz-Signature=0123456789abcdef0123',
      'https://s3.amazonaws.com/b/k?X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted]',
    ],
    [
      'OpenSSH private key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----\n[redacted]\n-----END OPENSSH PRIVATE KEY-----',
    ],
    [
      'PGP private key block with headers',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOYBF0123456789abcdef\n=Ab12\n-----END PGP PRIVATE KEY BLOCK-----',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\n[redacted]\n-----END PGP PRIVATE KEY BLOCK-----',
    ],
    [
      'truncated private key',
      'key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG',
      'key:\n-----BEGIN PRIVATE KEY-----\n[redacted]',
    ],
    [
      'private key with escaped newlines',
      'KEY="-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG\\nAAAA\\n-----END PRIVATE KEY-----"',
      'KEY="-----BEGIN PRIVATE KEY-----\\n[redacted]\\n-----END PRIVATE KEY-----"',
    ],
    [
      'Basic authorization header',
      'curl -H "Authorization: Basic dXNlcjpwYXNz" https://x',
      'curl -H "Authorization: Basic [redacted]" https://x',
    ],
    [
      'URL fragment token and a markdown link',
      '[cb](https://x/cb#access_token=abc0123456789xyz) and [d](https://x/a?key=abc0123456789xyz)',
      '[cb](https://x/cb#access_token=[redacted]) and [d](https://x/a?key=[redacted])',
    ],
    [
      'set of well-known token formats',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789 AWS=AKIAIOSFODNN7EXAMPLE G=AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
      'OPENAI_API_KEY=[redacted] GH=[redacted] AWS=[redacted] G=[redacted]',
    ],
    [
      'JSON string, which stays valid JSON',
      '{\n  "env": { "TOKEN": "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }\n}',
      '{"env":{"TOKEN":"[redacted]"}}',
    ],
  ])('redacts a %s', (_name, text, expected) => {
    expect(redactCredentialsInText(text)).toBe(expected);
  });

  test.each([
    'an email such as user@example.com',
    'a URL path with an at sign: https://example.com/@user/posts?page=2',
    '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\n-----END PUBLIC KEY-----',
    'grep -r "-----BEGIN PRIVATE KEY-----" src/',
    'set max_tokens=100 and the password policy',
    'a code comment // TODO',
    'prose such as the Bearer of bad news\nand Bearer authentication.',
    'an image URL such as https://example.com/i?key=logo.png&token=abc',
    '{ "pattern": "-----BEGIN PRIVATE KEY-----",  "path": "src/" }',
  ])('keeps %s', text => {
    expect(redactCredentialsInText(text)).toBe(text);
  });

  test.each([
    ['dotted words', 'a.'.repeat(100_000)],
    ['unterminated private key markers', '-----BEGIN PRIVATE KEY-----\n'.repeat(50_000)],
    ['URL-like prefixes', 'ab://'.repeat(100_000)],
  ])('stays fast on %s', (_name, text) => {
    const start = performance.now();
    redactCredentialsInText(text);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
