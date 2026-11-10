import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  RequestSummary,
  RoutingSections,
  type RequestLogDetails,
  type RequestLogRow,
} from '@/components/organizations/request-logs/RequestLogDetailsSheet';

const row: RequestLogRow = {
  id: 'ae1b636f-d211-4c04-96a9-3f1f2b7c8e10',
  created_at: '2026-11-10T09:12:44.000Z',
  user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
  model: 'anthropic/claude-haiku-5.5',
  provider: 'Amazon Bedrock',
  cost_microdollars: 0,
  input_tokens: 39_322,
  output_tokens: 294,
  cache_hit_tokens: 38_376,
  is_user_byok: true,
  has_error: false,
  project_id: null,
  feature: 'vscode-extension',
  latency_ms: 1_660,
  generation_time_ms: 1_890,
};

const request: RequestLogDetails['request'] = {
  model: 'claude-haiku-5-5',
  requested_model: 'anthropic/claude-haiku-5.5',
  provider: 'bedrock-byok',
  inference_provider: 'Amazon Bedrock',
  cache_write_tokens: 944,
  status_code: 200,
  finish_reason: 'end_turn',
  api_kind: 'messages',
  streamed: true,
  auto_model: null,
  session_id: 'ses_e3ed1c3b0ffe6jOGmgh5Xk2TqLw9',
  editor_name: 'Visual Studio Code 1.145.2',
  mode: 'code',
  inference_region: null,
};

const directByokDetails: RequestLogDetails = {
  request,
  metadata: {
    status: 'available',
    routing: {
      requested_model: 'anthropic/claude-haiku-5.5',
      api_kind: 'messages',
      owner_type: 'organization',
      steps: [
        { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' },
        { step: 'direct-byok-model', outcome: 'skipped', reason: 'no-match' },
        { step: 'organization-policy', excluded_provider_ids: ['opencode-go'] },
        {
          step: 'byok-key',
          outcome: 'selected',
          route: 'direct-byok',
          provider_id: 'bedrock-byok',
        },
      ],
      byok_candidates: [
        {
          route: 'direct-byok',
          provider_id: 'bedrock-byok',
          priority: 1,
          default_rank: 0,
          route_order: 0,
          outcome: 'selected',
        },
        {
          route: 'gateway-byok',
          provider_id: 'vercel-ai-gateway',
          priority: 2,
          default_rank: 1,
          route_order: 1,
          outcome: 'unreached',
        },
      ],
      result: {
        kind: 'provider',
        route: 'direct-byok',
        provider_type: 'direct-byok',
        byok_provider_ids: ['bedrock-byok'],
        payer: 'owner-byok-key',
        is_free: false,
      },
      enkrypt: {
        settings: {
          status: 'ready',
          detectors: [
            { detector: 'injection_attack', action: 'log' },
            { detector: 'policy_violation', action: 'log', policy_format: 'text' },
          ],
        },
        verdict: 'skip',
        unavailable_reason: null,
        added_latency_ms: 0,
        scans: [
          {
            scan: 'log_only',
            detectors_enabled: ['injection_attack', 'policy_violation'],
            detectors_blocking: [],
            verdict_cache: 'hit',
            verdict_cache_write: 'written',
            total_characters: 106_026,
            total_segments: 36,
            cached_characters: 102_989,
            cached_segments: 34,
            scanned_characters: 3_037,
            decision: 'allowed',
            error: null,
            detectors_fired: [],
            attempts: 1,
            credits_cost: null,
            latency_ms: 747,
          },
        ],
      },
      enkrypt_output: null,
      byok_failover_attempts: [],
    },
  },
};

const promotionalModelDetails: RequestLogDetails = {
  request: {
    ...request,
    model: 'acme/coder-free',
    requested_model: 'acme/coder-free',
    provider: 'custom',
    inference_provider: 'Acme',
    api_kind: 'chat_completions',
    finish_reason: 'stop',
  },
  metadata: {
    status: 'available',
    routing: {
      requested_model: 'acme/coder-free',
      api_kind: 'chat_completions',
      owner_type: 'organization',
      steps: [{ step: 'custom-llm', outcome: 'selected', visibility: 'public' }],
      byok_candidates: [],
      result: {
        kind: 'provider',
        route: 'custom-llm',
        provider_type: 'custom-public',
        byok_provider_ids: [],
        payer: 'custom-llm-credential',
        is_free: true,
      },
      enkrypt: null,
      enkrypt_output: null,
      byok_failover_attempts: [],
    },
  },
};

const kiloGatewayDetails: RequestLogDetails = {
  request: {
    ...request,
    requested_model: 'kilo-auto/efficient',
    provider: 'vercel',
    inference_provider: 'Anthropic',
    auto_model: 'anthropic/claude-haiku-5.5',
  },
  metadata: {
    status: 'available',
    routing: {
      requested_model: 'kilo-auto/efficient',
      api_kind: 'messages',
      owner_type: 'organization',
      steps: [
        { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' },
        { step: 'direct-byok-model', outcome: 'skipped', reason: 'no-match' },
        { step: 'byok-key', outcome: 'skipped', reason: 'no-candidates' },
        {
          step: 'kilo',
          outcome: 'selected',
          gateway: 'vercel',
          bounded_spending: false,
          organization_disabled_vercel_ai_gateway: false,
          kilo_ignored_providers: ['novitaai', 'deepinfra'],
        },
      ],
      byok_candidates: [],
      result: {
        kind: 'provider',
        route: 'kilo',
        provider_type: 'vercel',
        byok_provider_ids: [],
        payer: 'kilo',
        is_free: false,
      },
      enkrypt: null,
      enkrypt_output: null,
      byok_failover_attempts: [],
    },
  },
};

const byokFailoverDetails: RequestLogDetails = {
  request: {
    ...request,
    model: 'openai/gpt-5.2',
    requested_model: 'openai/gpt-5.2',
    provider: 'openrouter',
    inference_provider: 'OpenAI',
    cache_write_tokens: 0,
    finish_reason: 'stop',
    api_kind: 'chat_completions',
  },
  metadata: {
    status: 'available',
    routing: {
      requested_model: 'openai/gpt-5.2',
      api_kind: 'chat_completions',
      owner_type: 'organization',
      steps: [
        { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' },
        { step: 'direct-byok-model', outcome: 'skipped', reason: 'no-match' },
        { step: 'byok-key', outcome: 'selected', route: 'vercel-byok', provider_id: 'openai' },
      ],
      byok_candidates: [
        {
          route: 'vercel-byok',
          provider_id: 'openai',
          priority: 1,
          default_rank: 0,
          route_order: 0,
          outcome: 'selected',
        },
        {
          route: 'vercel-byok',
          provider_id: 'azure',
          priority: 2,
          default_rank: 1,
          route_order: 1,
          outcome: 'unreached',
        },
        {
          route: 'gateway-byok',
          provider_id: 'openrouter',
          priority: 3,
          default_rank: 2,
          route_order: 2,
          outcome: 'unreached',
        },
      ],
      result: {
        kind: 'provider',
        route: 'vercel-byok',
        provider_type: 'vercel',
        byok_provider_ids: ['openai'],
        payer: 'owner-byok-key',
        is_free: false,
      },
      enkrypt: null,
      enkrypt_output: null,
      byok_failover_attempts: [
        {
          provider_type: 'vercel',
          byok_provider_ids: ['openai'],
          status: 429,
          error_code: 'insufficient_quota',
          duration_ms: 412,
          outcome: 'failed-over',
        },
        {
          provider_type: 'vercel',
          byok_provider_ids: ['azure'],
          status: 503,
          error_code: 'upstream_disconnect',
          duration_ms: 30_004,
          outcome: 'failed-over',
        },
        {
          provider_type: 'openrouter',
          byok_provider_ids: ['openrouter'],
          status: 200,
          duration_ms: 1_187,
          outcome: 'served',
        },
      ],
    },
  },
};

function RequestLogDetailsBody({
  row,
  details,
}: {
  row: RequestLogRow;
  details: RequestLogDetails;
}) {
  return (
    <div className="flex flex-col gap-8 p-6">
      <RequestSummary row={row} details={details} />
      <RoutingSections metadata={details.metadata} />
    </div>
  );
}

const meta: Meta<typeof RequestLogDetailsBody> = {
  title: 'Organizations/Request Logs/RequestLogDetails',
  component: RequestLogDetailsBody,
  parameters: {
    layout: 'fullscreen',
    nextjs: { appDirectory: false },
  },
  decorators: [
    Story => (
      <div className="bg-background min-h-screen">
        <div className="bg-card w-full max-w-2xl border-l">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const DirectByok: Story = {
  args: { row, details: directByokDetails },
};

export const ByokFailover: Story = {
  args: {
    row: {
      ...row,
      model: 'openai/gpt-5.2',
      provider: 'OpenAI',
      input_tokens: 12_480,
      output_tokens: 655,
      cache_hit_tokens: 0,
      latency_ms: 31_740,
      generation_time_ms: 4_210,
    },
    details: byokFailoverDetails,
  },
};

export const PromotionalModel: Story = {
  args: {
    row: { ...row, model: 'acme/coder-free', provider: 'Acme', is_user_byok: false },
    details: promotionalModelDetails,
  },
};

export const KiloGateway: Story = {
  args: {
    row: {
      ...row,
      model: 'kilo-auto/efficient',
      provider: 'Anthropic',
      is_user_byok: false,
      cost_microdollars: 41_250,
    },
    details: kiloGatewayDetails,
  },
};
