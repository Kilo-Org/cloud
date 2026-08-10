import { GoogleAuth } from 'google-auth-library';
import {
  CustomLlmCredentialsSchema,
  CustomLlmDefinitionSchema,
  type GoogleServiceAccountKey,
} from '@kilocode/db/schema-types';
import { getGoogleServiceAccountAccessToken } from './google-service-account';

jest.mock('google-auth-library');

const mockGoogleAuth = jest.mocked(GoogleAuth);

function serviceAccount(privateKey: string): GoogleServiceAccountKey {
  return {
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'key-id',
    private_key: privateKey,
    client_email: 'custom-llm@example-project.iam.gserviceaccount.com',
    client_id: '1234567890',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/custom-llm%40example-project.iam.gserviceaccount.com',
  };
}

const baseDefinition = {
  internal_id: 'gemini-2.5-pro',
  display_name: 'Vertex Gemini',
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  base_url: 'https://us-central1-aiplatform.googleapis.com/v1',
  organization_ids: ['org-1'],
};

describe('CustomLlmCredentialsSchema and CustomLlmDefinitionSchema', () => {
  it('accepts API key credentials', () => {
    expect(
      CustomLlmCredentialsSchema.safeParse({ type: 'api_key', api_key: 'partner-token' }).success
    ).toBe(true);
  });

  it('accepts Google Cloud service account authentication', () => {
    expect(CustomLlmCredentialsSchema.safeParse(serviceAccount('private-key')).success).toBe(true);
  });

  it('validates custom LLM definition without credentials', () => {
    expect(CustomLlmDefinitionSchema.safeParse(baseDefinition).success).toBe(true);
  });
});

describe('getGoogleServiceAccountAccessToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests a cloud-platform access token with the supplied credentials', async () => {
    const getAccessToken = jest.fn(async () => 'gcp-token');
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);
    const credentials = serviceAccount('private-key-one');

    await expect(getGoogleServiceAccountAccessToken(credentials)).resolves.toBe('gcp-token');
    expect(mockGoogleAuth).toHaveBeenCalledWith({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  });

  it('reuses the Google auth client so its access token cache remains effective', async () => {
    const getAccessToken = jest.fn(async () => 'cached-token');
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);
    const credentials = serviceAccount('private-key-two');

    await getGoogleServiceAccountAccessToken(credentials);
    await getGoogleServiceAccountAccessToken(credentials);

    expect(mockGoogleAuth).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('fails when Google returns no access token', async () => {
    const getAccessToken = jest.fn(async () => null);
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);

    await expect(
      getGoogleServiceAccountAccessToken(serviceAccount('private-key-three'))
    ).rejects.toThrow('Google service account authentication returned no access token');
  });
});
