import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { OPENAI_CHATGPT_API_URL } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/upstream';
import { MARTIAN } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import DIRECT_BYOK_PROVIDERS from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-definitions';
import type { ProviderApiUrlOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { DirectByokProviderMetaId } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import type { DirectByokResolveUpstreamInput } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { AWS_BEDROCK_ENDPOINTS } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/aws-bedrock';
import { GCP_VERTEX_ENDPOINTS } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/gcp-vertex';
import {
  clearUpstreamUrlPolicyCache,
  findUpstreamUrlViolation,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account', () => ({
  getGoogleServiceAccountAccessToken: jest.fn(async () => 'test-token'),
}));

const TEST_CREDENTIALS: Partial<Record<DirectByokProviderMetaId, string>> = {
  'aws-bedrock': JSON.stringify({
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    region: 'us-east-1',
  }),
  'gcp-vertex': JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key: 'private-key',
    client_email: 'gateway@example-project.iam.gserviceaccount.com',
  }),
};

// Providers that route models to different hosts by endpoint.
const TEST_MODELS: Partial<
  Record<DirectByokProviderMetaId, ReadonlyArray<DirectByokResolveUpstreamInput['model']>>
> = {
  'aws-bedrock': Object.keys(AWS_BEDROCK_ENDPOINTS).map(endpoint => ({
    id: 'test-model',
    endpoint,
  })),
  'gcp-vertex': Object.keys(GCP_VERTEX_ENDPOINTS).map(endpoint => ({ id: 'test-model', endpoint })),
};

function urlsOf(name: string, apiUrl: string, overrides: ProviderApiUrlOverrides) {
  return [
    [name, apiUrl],
    ...Object.entries(overrides).map(([chatApi, url]) => [`${name} (${chatApi})`, url]),
  ];
}

// Every upstream URL hard-coded in the gateway's chat providers. Custom LLM
// URLs come from the database, and the local fake LLM only runs in development.
const PROVIDER_URLS = [
  ...urlsOf(OPENROUTER.id, OPENROUTER.apiUrl, OPENROUTER.apiUrlOverrides),
  ...urlsOf(VERCEL_AI_GATEWAY.id, VERCEL_AI_GATEWAY.apiUrl, VERCEL_AI_GATEWAY.apiUrlOverrides),
  ...urlsOf(MARTIAN.id, MARTIAN.apiUrl, MARTIAN.apiUrlOverrides),
  ...kiloExclusiveModels.flatMap(model =>
    urlsOf(
      `kilo-exclusive ${model.public_id}`,
      model.provider.apiUrl,
      model.provider.apiUrlOverrides
    )
  ),
  ['openai-chatgpt', OPENAI_CHATGPT_API_URL],
];

async function expectPassesUpstreamUrlPolicy(url: string) {
  clearUpstreamUrlPolicyCache();
  const resolvedHosts: string[] = [];
  const violation = await findUpstreamUrlViolation(url, {
    resolveHostAddresses: async hostname => {
      resolvedHosts.push(hostname);
      return ['104.18.2.115'];
    },
  });

  expect(violation).toBeNull();
  expect(resolvedHosts).toHaveLength(1);
}

describe('hard-coded provider URLs', () => {
  // DNS answers are not part of the code, so the resolver reports a public
  // address; this checks the scheme and host each URL is written with.
  it.each(PROVIDER_URLS)('%s (%s) passes the upstream URL policy', async (_name, url) => {
    await expectPassesUpstreamUrlPolicy(url);
  });

  it.each(DIRECT_BYOK_PROVIDERS.map(provider => [provider.id, provider] as const))(
    'direct-byok %s passes the upstream URL policy',
    async (id, provider) => {
      for (const model of TEST_MODELS[id] ?? [{ id: 'test-model' }]) {
        const upstream = await provider.resolveUpstream({
          credential: TEST_CREDENTIALS[id] ?? 'test-credential',
          model,
          stream: false,
        });
        for (const [, url] of urlsOf(id, upstream.apiUrl, upstream.apiUrlOverrides)) {
          await expectPassesUpstreamUrlPolicy(url);
        }
      }
    }
  );
});
