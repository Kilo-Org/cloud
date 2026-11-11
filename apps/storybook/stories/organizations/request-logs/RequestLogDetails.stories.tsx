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
            part: 'tools',
            detectors_enabled: ['injection_attack', 'policy_violation'],
            detectors_blocking: [],
            verdict_cache: 'hit',
            verdict_cache_write: 'skipped',
            total_characters: 35_412,
            total_segments: 17,
            cached_characters: 35_412,
            cached_segments: 17,
            omitted_attachments: 0,
            scanned_characters: 0,
            decision: 'allowed',
            error: null,
            detectors_fired: [],
            attempts: 0,
            credits_cost: null,
            latency_ms: 0,
          },
          {
            scan: 'log_only',
            part: 'system',
            detectors_enabled: ['injection_attack', 'policy_violation'],
            detectors_blocking: [],
            verdict_cache: 'miss',
            verdict_cache_write: 'written',
            total_characters: 6_456,
            total_segments: 1,
            cached_characters: 0,
            cached_segments: 0,
            omitted_attachments: 0,
            scanned_characters: 6_456,
            decision: 'allowed',
            error: null,
            detectors_fired: [],
            attempts: 1,
            credits_cost: null,
            latency_ms: 612,
          },
          {
            scan: 'log_only',
            part: 'conversation',
            detectors_enabled: ['injection_attack', 'policy_violation'],
            detectors_blocking: [],
            verdict_cache: 'hit',
            verdict_cache_write: 'written',
            total_characters: 64_156,
            total_segments: 71,
            cached_characters: 59_027,
            cached_segments: 68,
            omitted_attachments: 1,
            scanned_characters: 9_168,
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
    },
  },
};

const enkryptBlockedDetails: RequestLogDetails = {
  request: {
    ...request,
    model: 'anthropic/claude-haiku-5.5',
    provider: 'openrouter',
    inference_provider: null,
    cache_write_tokens: 0,
    status_code: 400,
    finish_reason: null,
    api_kind: 'chat_completions',
    streamed: true,
  },
  metadata: {
    status: 'available',
    routing: {
      requested_model: 'anthropic/claude-haiku-5.5',
      api_kind: 'chat_completions',
      owner_type: 'organization',
      steps: [
        { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' },
        { step: 'direct-byok-model', outcome: 'skipped', reason: 'no-match' },
        { step: 'byok-key', outcome: 'skipped', reason: 'no-candidates' },
        {
          step: 'kilo',
          outcome: 'selected',
          gateway: 'openrouter',
          bounded_spending: false,
          organization_disabled_vercel_ai_gateway: false,
          kilo_ignored_providers: [],
        },
      ],
      byok_candidates: [],
      result: {
        kind: 'provider',
        route: 'kilo',
        provider_type: 'openrouter',
        byok_provider_ids: [],
        payer: 'kilo',
        is_free: false,
      },
      enkrypt: {
        settings: {
          status: 'ready',
          detectors: [{ detector: 'injection_attack', action: 'block' }],
        },
        verdict: 'block',
        unavailable_reason: null,
        added_latency_ms: 191,
        scans: [
          {
            scan: 'blocking',
            part: 'conversation',
            detectors_enabled: ['injection_attack'],
            detectors_blocking: ['injection_attack'],
            verdict_cache: 'miss',
            verdict_cache_write: 'skipped',
            total_characters: 148,
            total_segments: 1,
            cached_characters: 0,
            cached_segments: 0,
            omitted_attachments: 0,
            scanned_characters: 148,
            decision: 'blocked',
            error: null,
            detectors_fired: ['injection_attack'],
            attempts: 1,
            credits_cost: 2,
            latency_ms: 197,
          },
        ],
      },
      enkrypt_output: null,
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

export const BlockedByEnkryptInputGuardrail: Story = {
  args: {
    row: {
      ...row,
      provider: null,
      is_user_byok: false,
      input_tokens: 0,
      output_tokens: 0,
      cache_hit_tokens: 0,
      has_error: true,
      latency_ms: 214,
      generation_time_ms: null,
    },
    details: enkryptBlockedDetails,
  },
};
