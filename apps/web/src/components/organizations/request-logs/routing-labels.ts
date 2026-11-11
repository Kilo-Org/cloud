import { apiKindLabel } from '@/lib/api-kind-labels';
import { byokKeyLabel, getByokProviderDisplayName } from '@/lib/byok/provider-names';
import { normalizePublicInferenceProvider } from '@/lib/public-inference-provider';
import type {
  RequestLogRoutingResult,
  RequestLogRoutingStep,
} from '@/lib/request-logs/routing-details';

export type StepTone = 'selected' | 'skipped' | 'rejected' | 'deferred' | 'info';

export type DescribedStep = {
  title: string;
  detail: string;
  tone: StepTone;
};

export type DescribedResult = {
  title: string;
  paidBy: string | null;
};

const GATEWAY_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter',
  vercel: 'Vercel AI Gateway',
};

export const BYOK_SKIP_REASON_LABELS: Record<string, string> = {
  'unsupported-api-kind': 'Does not support this API',
  disabled: 'Key disabled',
  'not-catalog-mode': 'Key uses provider model IDs',
  'model-unavailable': 'Model not offered through this gateway',
  'provider-settings': 'Excluded by provider settings',
  'ignored-by-request': 'Provider ignored by the request',
};

export const BYOK_OUTCOME_LABELS: Record<string, string> = {
  selected: 'Selected',
  skipped: 'Skipped',
  unreached: 'Not reached',
};

const PAYER_LABELS: Record<string, string> = {
  none: 'Nobody',
  'chatgpt-subscription': 'ChatGPT subscription',
  'customer-claude-organization': 'Claude organization',
};

const PROMOTIONAL_MODEL_PROVIDER = "the promotional model's provider";

const SENT_TO_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  vercel: 'Vercel AI Gateway',
  inception: 'Inception',
  mistral: 'Mistral',
  'openai-chatgpt': 'OpenAI (ChatGPT)',
  'claude-billing': 'Anthropic (Claude organization)',
  custom: PROMOTIONAL_MODEL_PROVIDER,
  'custom-public': PROMOTIONAL_MODEL_PROVIDER,
  'dev-tools': 'Development tools',
};

const REJECTED_RESULT_LABELS: Record<string, string> = {
  'chatgpt-reconnect': 'Rejected: the ChatGPT connection must be reconnected',
  'claude-billing-unavailable': 'Rejected: Claude organization billing is unavailable',
  'claude-billing-reconnect': 'Rejected: the Claude organization link must be reconnected',
  'custom-llm-unavailable': 'Rejected: the promotional model is unavailable',
  'direct-byok-catalog-only': 'Rejected: the key only serves Kilo catalog model IDs',
};

const PROMOTIONAL_MODEL_REJECTION_LABELS: Record<string, string> = {
  'country-denied': 'This promotional model is not available in the country the request came from.',
  'not-eligible': 'This promotional model is not available to this user.',
  'invalid-credentials': 'This promotional model is temporarily unavailable.',
};

function lookup(labels: Record<string, string>, value: string): string {
  return Object.hasOwn(labels, value) ? labels[value] : value;
}

/** Only OpenRouter and Vercel AI Gateway are gateways; other providers are called directly. */
export function gatewayName(provider: string): string | null {
  return Object.hasOwn(GATEWAY_NAMES, provider) ? GATEWAY_NAMES[provider] : null;
}

function keyLabel(providerIds: string[]): string {
  return byokKeyLabel(providerIds.map(getByokProviderDisplayName));
}

function listOf(names: string[]): string {
  return names.join(', ');
}

export function byokSkipReasonLabel(reason: string): string {
  return lookup(BYOK_SKIP_REASON_LABELS, reason);
}

export function byokOutcomeLabel(outcome: string): string {
  return lookup(BYOK_OUTCOME_LABELS, outcome);
}

export function rejectedResultLabel(result: RequestLogRoutingResult): string {
  return lookup(REJECTED_RESULT_LABELS, result.kind);
}

/** Kilo bills both its gateway and promotional models, so their payer is Kilo credits or free. */
function paidByLabel(result: RequestLogRoutingResult): string | null {
  const payer = result.payer;
  if (!payer) return null;
  switch (payer) {
    case 'kilo':
    case 'custom-llm-credential':
      return result.is_free ? 'Free' : 'Kilo credits';
    case 'owner-byok-key': {
      const providerIds = result.byok_provider_ids ?? [];
      return providerIds.length > 0 ? keyLabel(providerIds) : 'BYOK key';
    }
    default:
      return lookup(PAYER_LABELS, payer);
  }
}

function sentToLabel(result: RequestLogRoutingResult): string {
  const providerType = result.provider_type;
  if (!providerType) return 'Provider selected';
  if (providerType === 'direct-byok') {
    const providerIds = result.byok_provider_ids ?? [];
    return providerIds.length > 0
      ? `Sent to ${listOf(providerIds.map(getByokProviderDisplayName))}`
      : 'Sent to the BYOK provider';
  }
  return `Sent to ${lookup(SENT_TO_LABELS, providerType)}`;
}

export function describeResult(result: RequestLogRoutingResult): DescribedResult {
  return { title: sentToLabel(result), paidBy: paidByLabel(result) };
}

function toneOf(outcome: string | undefined): StepTone {
  switch (outcome) {
    case 'selected':
    case 'skipped':
    case 'rejected':
    case 'deferred':
      return outcome;
    default:
      return 'info';
  }
}

function describePromotionalModel(step: RequestLogRoutingStep): string {
  if (step.outcome === 'selected') return 'The requested model is a promotional model.';
  if (step.outcome === 'rejected' && step.reason) {
    return lookup(PROMOTIONAL_MODEL_REJECTION_LABELS, step.reason);
  }
  return 'The requested model is not a promotional model.';
}

function describeProviderModelId(step: RequestLogRoutingStep): string {
  const key = step.provider_id ? keyLabel([step.provider_id]) : 'BYOK key';
  if (step.outcome === 'selected') return `Served with the ${key}.`;
  if (step.outcome === 'rejected') {
    return step.catalog_model_id
      ? `The ${key} only serves Kilo catalog model IDs; request ${step.catalog_model_id} instead.`
      : `The ${key} only serves Kilo catalog model IDs.`;
  }
  if (step.reason === 'no-key') return `No ${key} is configured.`;
  return "The requested model is not a BYOK provider's own model ID.";
}

function describeChatGpt(step: RequestLogRoutingStep): string {
  switch (step.outcome) {
    case 'selected':
      return 'Served by the connected ChatGPT subscription.';
    case 'rejected':
      return 'The ChatGPT connection must be reconnected.';
    case 'deferred':
      return 'A higher-ranked BYOK key serves this model, so the connection was not checked.';
    default:
      return 'No ChatGPT connection is available.';
  }
}

function describeByokKey(step: RequestLogRoutingStep): string {
  if (step.outcome === 'selected') {
    const key = step.provider_id ? keyLabel([step.provider_id]) : 'BYOK key';
    const through = step.route === 'vercel-byok' ? ' through Vercel AI Gateway' : '';
    return `Served with the ${key}${through}.`;
  }
  return step.reason === 'none-served'
    ? 'None of the BYOK keys could serve the request.'
    : 'No BYOK key can serve this model.';
}

function describeKilo(step: RequestLogRoutingStep): string {
  const gateway = (step.gateway ? gatewayName(step.gateway) : null) ?? 'a Kilo gateway';
  return `Paid with Kilo credits and routed through ${gateway}.`;
}

export function inferenceProviderNames(providers: string[]): string {
  return listOf(providers.map(provider => normalizePublicInferenceProvider(provider).name));
}

export function describeStep(step: RequestLogRoutingStep): DescribedStep {
  const tone = toneOf(step.outcome);
  switch (step.step) {
    case 'local-fake-llm':
      return { title: 'Local fake LLM', detail: 'Served by the local development model.', tone };
    case 'custom-llm':
      return { title: 'Promotional model', detail: describePromotionalModel(step), tone };
    case 'direct-byok-model':
      return { title: 'Provider model ID', detail: describeProviderModelId(step), tone };
    case 'organization-policy': {
      const excluded = step.excluded_provider_ids ?? [];
      return {
        title: 'Organization policy',
        detail:
          excluded.length > 0
            ? `Excluded BYOK providers: ${listOf(excluded.map(getByokProviderDisplayName))}.`
            : 'No providers excluded.',
        tone: 'info',
      };
    }
    case 'chatgpt':
      return { title: 'ChatGPT subscription', detail: describeChatGpt(step), tone };
    case 'claude-billing':
      return {
        title: 'Claude organization',
        detail:
          step.outcome === 'selected'
            ? 'Paid by the connected Claude organization.'
            : 'Claude organization billing is unavailable.',
        tone,
      };
    case 'byok-key':
      return { title: 'BYOK keys', detail: describeByokKey(step), tone };
    case 'unsupported-api-kind': {
      const key = step.provider_id ? keyLabel([step.provider_id]) : 'BYOK key';
      const supported = step.supported_api_kinds?.map(apiKindLabel).join(' and ');
      return {
        title: 'BYOK key over another API',
        detail: `No key serves this API, so the request went to the ${key}${supported ? `, which supports ${supported}` : ''}.`,
        tone,
      };
    }
    case 'kilo':
      return { title: 'Kilo credits', detail: describeKilo(step), tone };
    default:
      return {
        title: step.step,
        detail: [step.outcome, step.reason].filter(Boolean).join(': '),
        tone,
      };
  }
}
