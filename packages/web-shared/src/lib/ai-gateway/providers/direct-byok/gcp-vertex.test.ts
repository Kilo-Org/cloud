import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { GatewayRequest } from '../openrouter/types';
import { ReasoningDetailsTransform, type TransformRequestContext } from '../types';
import { getGoogleServiceAccountAccessToken } from '../../custom-llm/google-service-account';
import gcpVertex, {
  buildGcpVertexUpstream,
  getGcpVertexHost,
  parseGcpVertexCredentials,
  resolveGcpVertexUpstream,
} from './gcp-vertex';

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
      buildGcpVertexUpstream(credentials, 'token', { id: 'gemini-3.5-flash', endpoint: 'openapi' }, true)
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

describe('gcpVertex definition', () => {
  function createContext(request: GatewayRequest): TransformRequestContext {
    return {
      provider: {
        id: 'direct-byok',
        apiUrl: gcpVertex.base_url,
        apiUrlOverrides: {},
        disableUrlSuffix: false,
        apiKey: 'token',
        apiKeyHeader: null,
        supportedChatApis: gcpVertex.supported_chat_apis,
        responseTransforms: null,
        async transformRequest() {},
      },
      model: 'gcp-vertex/model',
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

    gcpVertex.transformRequest(context);

    expect(context.request.body).toEqual({
      messages: [],
      max_tokens: 10,
      anthropic_version: 'vertex-2023-10-16',
    });
  });

  it.each([
    ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
    ['zai-org/glm-5.2-maas', 'zai-org/glm-5.2-maas'],
  ])('sends %s as %s to the OpenAI-compatible endpoint', (model, upstreamModel) => {
    const context = createContext({ kind: 'chat_completions', body: { model, messages: [] } });

    gcpVertex.transformRequest(context);

    expect(context.request.body.model).toBe(upstreamModel);
  });
});
