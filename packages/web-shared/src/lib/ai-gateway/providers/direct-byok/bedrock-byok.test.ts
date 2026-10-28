import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { GatewayRequest } from '../openrouter/types';
import { ReasoningDetailsTransform, type TransformRequestContext } from '../types';
import awsBedrock, { parseAwsBedrockCredentials, resolveAwsBedrockUpstream } from './bedrock-byok';

const iamCredential = JSON.stringify({
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  region: 'eu-west-1',
});
const apiKeyCredential = JSON.stringify({ apiKey: 'bedrock-api-key', region: 'us-east-1' });

describe('resolveAwsBedrockUpstream', () => {
  it.each([
    {
      endpoint: 'mantle-chat',
      id: 'zai.glm-5',
      apiUrl: 'https://bedrock-mantle.eu-west-1.api.aws/v1',
      api: 'chat_completions',
      responseTransforms: ReasoningDetailsTransform.Reasoning,
    },
    {
      endpoint: 'mantle-openai',
      id: 'openai.gpt-5.5',
      apiUrl: 'https://bedrock-mantle.eu-west-1.api.aws/openai/v1',
      api: 'responses',
      responseTransforms: null,
    },
    {
      endpoint: 'runtime-anthropic',
      id: 'global.anthropic.claude-sonnet-4-6',
      apiUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com/anthropic/v1',
      api: 'messages',
      responseTransforms: null,
    },
    {
      endpoint: 'runtime-openai',
      id: 'global.zai.glm-5.3',
      apiUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
      api: 'chat_completions',
      responseTransforms: ReasoningDetailsTransform.Reasoning,
    },
    {
      endpoint: 'runtime-openai',
      id: 'global.moonshotai.kimi-k3',
      apiUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
      api: 'chat_completions',
      responseTransforms: ReasoningDetailsTransform.ReasoningContent,
    },
    {
      endpoint: 'runtime-responses',
      id: 'global.xai.grok-4.7',
      apiUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
      api: 'responses',
      responseTransforms: null,
    },
  ] as const)(
    'routes $id on $endpoint to $apiUrl and signs with IAM keys',
    ({ endpoint, id, apiUrl, api, responseTransforms }) => {
      expect(resolveAwsBedrockUpstream(iamCredential, { id, endpoint })).toEqual({
        apiUrl,
        apiUrlOverrides: {},
        disableUrlSuffix: false,
        supportedChatApis: [api],
        responseTransforms,
        apiKey: '',
        apiKeyHeader: null,
        awsBedrock: {
          type: 'aws_bedrock',
          region: 'eu-west-1',
          access_key_id: 'AKIDEXAMPLE',
          secret_access_key: 'secret',
        },
      });
    }
  );

  it('infers the endpoint from the model id when the catalog has none', () => {
    expect(
      resolveAwsBedrockUpstream(iamCredential, { id: 'global.anthropic.claude-opus-5' }).apiUrl
    ).toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/anthropic/v1');
    expect(resolveAwsBedrockUpstream(iamCredential, { id: 'qwen.qwen3-32b-v1:0' }).apiUrl).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1'
    );
  });

  it('sends a Bedrock API key as a bearer token, or as x-api-key for Messages', () => {
    const chat = resolveAwsBedrockUpstream(apiKeyCredential, {
      id: 'zai.glm-5',
      endpoint: 'runtime-openai',
    });
    expect(chat).toMatchObject({ apiKey: 'bedrock-api-key', apiKeyHeader: null });
    expect(chat.awsBedrock).toBeUndefined();

    expect(
      resolveAwsBedrockUpstream(apiKeyCredential, {
        id: 'global.anthropic.claude-sonnet-4-6',
        endpoint: 'runtime-anthropic',
      })
    ).toMatchObject({ apiKey: 'bedrock-api-key', apiKeyHeader: 'x-api-key' });
  });
});

describe('parseAwsBedrockCredentials', () => {
  it.each([
    ['invalid JSON', 'not json'],
    ['a missing region', JSON.stringify({ accessKeyId: 'a', secretAccessKey: 'b' })],
    ['mixed auth methods', JSON.stringify({ apiKey: 'k', accessKeyId: 'a', region: 'us-east-1' })],
    [
      'a region that would change the host',
      JSON.stringify({ apiKey: 'k', region: 'us-east-1.attacker.example/x' }),
    ],
  ])('rejects %s', (_, credential) => {
    expect(() => parseAwsBedrockCredentials(credential)).toThrow();
  });
});

describe('awsBedrock definition', () => {
  function createContext(request: GatewayRequest): TransformRequestContext {
    return {
      provider: {
        id: 'direct-byok',
        apiUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
        apiUrlOverrides: {},
        disableUrlSuffix: false,
        apiKey: '',
        apiKeyHeader: null,
        supportedChatApis: ['chat_completions', 'messages', 'responses'],
        responseTransforms: null,
        async transformRequest() {},
      },
      model: 'bedrock-byok/global.anthropic.claude-sonnet-4-6',
      request,
      originalHeaders: EmptyFraudDetectionHeaders,
      extraHeaders: {},
      userByok: null,
      kilo_user_id: 'test-user',
      organization_id: null,
      session_id: null,
    };
  }

  it('adds the Anthropic API version to Messages requests only', () => {
    const messages = createContext({
      kind: 'messages',
      body: { model: 'global.anthropic.claude-sonnet-4-6', messages: [], max_tokens: 10 },
    });
    awsBedrock.transformRequest(messages);
    expect(messages.extraHeaders['anthropic-version']).toBe('2023-06-01');

    const chat = createContext({
      kind: 'chat_completions',
      body: { model: 'zai.glm-5', messages: [] },
    });
    awsBedrock.transformRequest(chat);
    expect(chat.extraHeaders).toEqual({});
  });

  it('tells clients which API each model uses', () => {
    const base = { name: 'm', context_length: 1, max_completion_tokens: 1 };
    expect(
      awsBedrock.getModelChatApi({ ...base, id: 'openai.gpt-5.5', endpoint: 'mantle-openai' })
    ).toBe('responses');
    expect(awsBedrock.getModelChatApi({ ...base, id: 'global.anthropic.claude-opus-5' })).toBe(
      'messages'
    );
    expect(awsBedrock.getModelChatApi({ ...base, id: 'zai.glm-5' })).toBe('chat_completions');
  });
});
