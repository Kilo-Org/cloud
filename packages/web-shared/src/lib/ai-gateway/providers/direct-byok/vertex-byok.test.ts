import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { GatewayRequest } from '../openrouter/types';
import { ReasoningDetailsTransform, type TransformRequestContext } from '../types';
import { getGoogleServiceAccountAccessToken } from '../../custom-llm/google-service-account';
import vertexByok, {
  buildGcpVertexUpstream,
  getGcpVertexHost,
  parseGcpVertexCredentials,
  resolveGcpVertexUpstream,
} from './vertex-byok';

jest.mock('../../custom-llm/google-service-account', () => ({
  getGoogleServiceAccountAccessToken: jest.fn(async () => 'gcp-token'),
}));

const serviceAccountKeyFile = {
  type: 'service_account',
  project_id: 'my-project',
  private_key_id: 'key-id',
  private_key: 'private-key',
  client_email: 'sa@my-project.iam.gserviceaccount.com',
  client_id: '123',
};

const credentials = {
  project: 'my-project',
  location: 'global',
  clientEmail: 'sa@my-project.iam.gserviceaccount.com',
  privateKey: 'private-key',
};

describe('parseGcpVertexCredentials', () => {
  it('accepts a service account key file and defaults the location to global', () => {
    expect(parseGcpVertexCredentials(JSON.stringify(serviceAccountKeyFile))).toEqual(credentials);
  });

  it('accepts a location on the key file', () => {
    expect(
      parseGcpVertexCredentials(JSON.stringify({ ...serviceAccountKeyFile, location: 'us' }))
        .location
    ).toBe('us');
  });

  it('accepts the Vercel-shaped Vertex credentials', () => {
    expect(
      parseGcpVertexCredentials(
        JSON.stringify({
          project: 'my-project',
          location: 'europe-west4',
          googleCredentials: {
            clientEmail: 'sa@my-project.iam.gserviceaccount.com',
            privateKey: 'private-key',
          },
        })
      )
    ).toEqual({ ...credentials, location: 'europe-west4' });
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a missing private key', JSON.stringify({ ...serviceAccountKeyFile, private_key: '' })],
    [
      'a location that would change the host',
      JSON.stringify({ ...serviceAccountKeyFile, location: 'evil.example/x' }),
    ],
    [
      'a project that would change the path',
      JSON.stringify({ ...serviceAccountKeyFile, project_id: '../other' }),
    ],
  ])('rejects %s', (_, credential) => {
    expect(() => parseGcpVertexCredentials(credential)).toThrow();
  });
});

describe('getGcpVertexHost', () => {
  it.each([
    ['global', 'aiplatform.googleapis.com'],
    ['us', 'aiplatform.us.rep.googleapis.com'],
    ['eu', 'aiplatform.eu.rep.googleapis.com'],
    ['us-central1', 'us-central1-aiplatform.googleapis.com'],
  ])('maps %s to %s', (location, host) => {
    expect(getGcpVertexHost(location)).toBe(host);
  });
});

describe('buildGcpVertexUpstream', () => {
  it('routes Gemini to the OpenAI-compatible endpoint with the Gemini reasoning transform', () => {
    expect(
      buildGcpVertexUpstream(
        credentials,
        'token',
        { id: 'gemini-3.5-flash', endpoint: 'openapi' },
        true
      )
    ).toEqual({
      apiKey: 'token',
      apiKeyHeader: null,
      apiUrlOverrides: {},
      apiUrl:
        'https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/endpoints/openapi',
      disableUrlSuffix: false,
      supportedChatApis: ['chat_completions'],
      responseTransforms: ReasoningDetailsTransform.GeminiThought,
    });
  });

  it('routes Grok reasoning models to the Responses API on the OpenAI-compatible endpoint', () => {
    expect(
      buildGcpVertexUpstream(
        credentials,
        'token',
        { id: 'xai/grok-4.20-reasoning', endpoint: 'openapi-responses' },
        true
      )
    ).toEqual({
      apiKey: 'token',
      apiKeyHeader: null,
      apiUrlOverrides: {},
      apiUrl:
        'https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/endpoints/openapi',
      disableUrlSuffix: false,
      supportedChatApis: ['responses'],
      responseTransforms: null,
    });
  });

  it.each([
    ['global', false, 'us-central1', 'rawPredict'],
    ['us-central1', true, 'us-central1', 'streamRawPredict'],
    ['eu', false, 'europe-west4', 'rawPredict'],
    ['europe-west1', false, 'europe-west4', 'rawPredict'],
  ])(
    'routes Mistral from location %s (stream: %s) to its %s rawPredict URL',
    (location, stream, mistralLocation, method) => {
      expect(
        buildGcpVertexUpstream(
          { ...credentials, location },
          'token',
          { id: 'mistral-medium-3', endpoint: 'mistral' },
          stream
        )
      ).toEqual({
        apiKey: 'token',
        apiKeyHeader: null,
        apiUrlOverrides: {},
        apiUrl: `https://${mistralLocation}-aiplatform.googleapis.com/v1/projects/my-project/locations/${mistralLocation}/publishers/mistralai/models/mistral-medium-3:${method}`,
        disableUrlSuffix: true,
        supportedChatApis: ['chat_completions'],
        responseTransforms: null,
      });
    }
  );

  it('maps reasoning_content for managed open models on the OpenAI-compatible endpoint', () => {
    expect(
      buildGcpVertexUpstream(credentials, 'token', { id: 'zai-org/glm-5.2-maas' }, false)
        .responseTransforms
    ).toBe(ReasoningDetailsTransform.ReasoningContent);
  });

  it.each([
    [false, 'rawPredict'],
    [true, 'streamRawPredict'],
  ])('routes Claude to its rawPredict URL (stream: %s)', (stream, method) => {
    expect(
      buildGcpVertexUpstream(
        { ...credentials, location: 'us' },
        'token',
        { id: 'claude-sonnet-4-6@default', endpoint: 'anthropic' },
        stream
      )
    ).toMatchObject({
      apiUrl: `https://aiplatform.us.rep.googleapis.com/v1/projects/my-project/locations/us/publishers/anthropic/models/claude-sonnet-4-6@default:${method}`,
      disableUrlSuffix: true,
      supportedChatApis: ['messages'],
    });
  });
});

describe('resolveGcpVertexUpstream', () => {
  it('mints an access token from the service account', async () => {
    const upstream = await resolveGcpVertexUpstream(
      JSON.stringify(serviceAccountKeyFile),
      { id: 'gemini-3.5-flash' },
      false
    );

    expect(upstream.apiKey).toBe('gcp-token');
    expect(getGoogleServiceAccountAccessToken).toHaveBeenCalledWith({
      client_email: 'sa@my-project.iam.gserviceaccount.com',
      private_key: 'private-key',
    });
  });
});

describe('vertexByok definition', () => {
  function createContext(request: GatewayRequest): TransformRequestContext {
    return {
      provider: {
        id: 'direct-byok',
        apiUrl: 'https://aiplatform.googleapis.com/v1',
        apiUrlOverrides: {},
        disableUrlSuffix: false,
        apiKey: 'token',
        apiKeyHeader: null,
        supportedChatApis: ['chat_completions', 'messages'],
        responseTransforms: null,
        async transformRequest() {},
      },
      model: 'vertex-byok/model',
      request,
      originalHeaders: EmptyFraudDetectionHeaders,
      extraHeaders: {},
      userByok: null,
      kilo_user_id: 'test-user',
      organization_id: null,
      session_id: null,
    };
  }

  it('moves the Claude model into the URL and sets the Vertex API version', () => {
    const context = createContext({
      kind: 'messages',
      body: { model: 'claude-sonnet-4-6@default', messages: [], max_tokens: 10 },
    });

    vertexByok.transformRequest(context);

    expect(context.request.body).toEqual({
      messages: [],
      max_tokens: 10,
      anthropic_version: 'vertex-2023-10-16',
    });
  });

  it('reduces Mistral requests to the fields Mistral accepts', () => {
    const context = createContext({
      kind: 'chat_completions',
      body: {
        model: 'mistral-medium-3',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: 'hello',
            reasoning: 'thinking',
            reasoning_details: [],
          } as never,
        ],
        max_completion_tokens: 100,
        seed: 7,
        stream: true,
        stream_options: { include_usage: true },
        user: 'user-hash',
        safety_identifier: 'user-hash',
        prompt_cache_key: 'session-hash',
        tools: [
          {
            type: 'function',
            function: { name: 'read', parameters: { type: 'object' }, strict: true },
          },
        ],
      },
    });

    vertexByok.transformRequest(context);

    expect(context.request.body).toEqual({
      model: 'mistral-medium-3',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      max_tokens: 100,
      random_seed: 7,
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    });
  });

  it.each([
    ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
    ['zai-org/glm-5.2-maas', 'zai-org/glm-5.2-maas'],
  ])('sends %s as %s to the OpenAI-compatible endpoint', (model, upstreamModel) => {
    const context = createContext({ kind: 'chat_completions', body: { model, messages: [] } });

    vertexByok.transformRequest(context);

    expect(context.request.body.model).toBe(upstreamModel);
  });
});
