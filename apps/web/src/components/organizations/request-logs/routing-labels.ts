import { apiKindLabel } from '@/lib/api-kind-labels';
import { byokKeyLabel, getByokProviderDisplayName } from '@/lib/byok/provider-names';
import { isByokPrivateProviderId } from '@kilocode/db/schema-types';
import { normalizePublicInferenceProvider } from '@/lib/public-inference-provider';
import type {
  RequestLogNotSentReason,
  RequestLogRoutingResult,
  RequestLogRoutingStep,
} from '@/lib/request-logs/routing-details';

export type StepTone = 'selected' | 'skipped' | 'rejected' | 'deferred' | 'info';

type DescribedStep = {
  title: string;
  detail: string;
  tone: StepTone;
};

type DescribedResult = {
  title: string;
  paidBy: string | null;
};

type DescribedUnsentResult = {
  title: string;
  detail: string | null;
};

const GATEWAY_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter',
  vercel: 'Vercel AI Gateway',
};

const BYOK_SKIP_REASON_LABELS: Record<string, string> = {
  'unsupported-api-kind': 'Does not support this API',
  disabled: 'Key disabled',
  'not-catalog-mode': 'Key uses provider model IDs',
  'model-unavailable': 'Model not offered through this gateway',
  'provider-settings': 'Excluded by provider settings',
  'ignored-by-request': 'Provider ignored by the request',
};

const PRIVATE_PROVIDER_SKIP_REASON_LABELS: Record<string, string> = {
  disabled: 'Private provider disabled',
  'not-catalog-mode': 'Private provider uses its own model IDs',
};

const BYOK_OUTCOME_LABELS: Record<string, string> = {
  selected: 'Selected',
  skipped: 'Skipped',
  unreached: 'Not reached',
  failed: 'Failed',
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
  'claude-billing-reconnect': 'Rejected: the Claude organization must be linked again',
  'custom-llm-unavailable': 'Rejected: the promotional model is unavailable',
  'byok-private-provider-unavailable': 'Rejected: the private provider is unavailable',
  'direct-byok-catalog-only':
    'Rejected: the key or private provider only serves Kilo catalog model IDs',
};

const NOT_SENT_LABELS: Record<RequestLogNotSentReason, string> = {
  'enkrypt-block': 'Not sent: blocked by the Enkrypt input guardrail',
  'enkrypt-unavailable': 'Not sent: the Enkrypt input guardrail was unavailable',
  'rejected-before-guardrail': 'Not sent: rejected before the Enkrypt input guardrail verdict',
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

/** A private provider is named by its provider id alone; every other BYOK provider is a key. */
function keyLabel(providerIds: string[]): string {
  const privateProviders = providerIds.filter(isByokPrivateProviderId);
  const keys = providerIds.filter(providerId => !isByokPrivateProviderId(providerId));
  const labels = privateProviders.map(getByokProviderDisplayName);
  if (keys.length > 0) labels.push(byokKeyLabel(keys.map(getByokProviderDisplayName)));
  return listOf(labels);
}

function listOf(names: string[]): string {
  return names.join(', ');
}

export function byokSkipReasonLabel(reason: string, providerId: string): string {
  if (
    isByokPrivateProviderId(providerId) &&
    Object.hasOwn(PRIVATE_PROVIDER_SKIP_REASON_LABELS, reason)
  ) {
    return PRIVATE_PROVIDER_SKIP_REASON_LABELS[reason];
  }
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

/** The partner a partner-first Kilo route sent the request to, from its `kilo` step. */
export function partnerInferenceProviderOf(
  steps: readonly RequestLogRoutingStep[]
): string | undefined {
  return steps.find(step => step.step === 'kilo')?.partner_inference_provider;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The display name of a partner, or a generic label when the routing record does not name it.
 * End users never see the word partner; the request log calls it a direct provider. */
export function partnerName(partnerInferenceProvider: string | undefined): string {
  return partnerInferenceProvider
    ? inferenceProviderNames([partnerInferenceProvider])
    : 'the direct provider';
}

function selectedProviderName(
  result: RequestLogRoutingResult,
  partnerInferenceProvider: string | undefined
): string | null {
  const providerType = result.provider_type;
  if (!providerType) return null;
  if (providerType === 'partner') return partnerName(partnerInferenceProvider);
  if (providerType === 'direct-byok') {
    const providerIds = result.byok_provider_ids ?? [];
    return providerIds.length > 0
      ? listOf(providerIds.map(getByokProviderDisplayName))
      : 'the BYOK provider';
  }
  return lookup(SENT_TO_LABELS, providerType);
}

export function describeResult(
  result: RequestLogRoutingResult,
  partnerInferenceProvider?: string
): DescribedResult {
  const provider = selectedProviderName(result, partnerInferenceProvider);
  return {
    title: provider ? `Sent to ${provider}` : 'Provider selected',
    paidBy: paidByLabel(result),
  };
}

/** Nothing was sent, so nobody paid; the detail names the provider Kilo had selected. */
export function describeUnsentResult(
  result: RequestLogRoutingResult,
  reason: RequestLogNotSentReason,
  partnerInferenceProvider?: string
): DescribedUnsentResult {
  const provider = selectedProviderName(result, partnerInferenceProvider);
  return {
    title: NOT_SENT_LABELS[reason],
    detail: provider ? `Would have been sent to ${provider}.` : null,
  };
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

/** Why an organization private provider could not serve its own model id, which no other route serves. */
const PRIVATE_PROVIDER_REJECTION_LABELS: Record<string, (privateProvider: string) => string> = {
  'no-organization': () => 'Private providers are only available to organizations.',
  'no-key': privateProvider => `This organization has no ${privateProvider}.`,
  disabled: privateProvider => `The ${privateProvider} is disabled.`,
  'unknown-model': privateProvider => `The ${privateProvider} does not offer the requested model.`,
  'invalid-credentials': privateProvider =>
    `The ${privateProvider}'s credentials could not be used.`,
};

function isPrivateProviderStep(step: RequestLogRoutingStep): boolean {
  return step.provider_id !== undefined && isByokPrivateProviderId(step.provider_id);
}

function describeProviderModelId(step: RequestLogRoutingStep): string {
  const key = step.provider_id ? keyLabel([step.provider_id]) : 'BYOK key';
  if (step.outcome === 'selected') return `Served with the ${key}.`;
  if (step.outcome === 'rejected') {
    if (step.reason && Object.hasOwn(PRIVATE_PROVIDER_REJECTION_LABELS, step.reason)) {
      return PRIVATE_PROVIDER_REJECTION_LABELS[step.reason](key);
    }
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

function describeByokKey(step: RequestLogRoutingStep, failedOver: boolean): string {
  if (step.outcome === 'selected') {
    const key = step.provider_id ? keyLabel([step.provider_id]) : 'BYOK key';
    const through = step.route === 'vercel-byok' ? ' through Vercel AI Gateway' : '';
    return failedOver
      ? `Tried the ${key}${through} first. It failed, so the request failed over to the next BYOK key.`
      : `Served with the ${key}${through}.`;
  }
  return step.reason === 'none-served'
    ? 'None of the BYOK keys could serve the request.'
    : 'No BYOK key can serve this model.';
}

const PARTNER_SKIP_REASON_LABELS: Record<string, string> = {
  'unsupported-api-kind': 'This API is not supported.',
  'server-features': 'The request uses plugins or server tools, which only the gateway runs.',
  'bounded-spending': 'The request carries a spend ceiling.',
  'openrouter-disabled': 'Excluded by the organization gateway settings.',
  'provider-settings': 'Excluded by provider settings.',
};

function describePartnerSkip(step: RequestLogRoutingStep): string {
  const reason = step.reason ? lookup(PARTNER_SKIP_REASON_LABELS, step.reason) : '';
  if (!step.partner_inference_provider) return reason;
  const partner = inferenceProviderNames([step.partner_inference_provider]);
  const lowered = reason.charAt(0).toLowerCase() + reason.slice(1);
  return `${partner} was skipped: ${lowered}`;
}

function describeKilo(step: RequestLogRoutingStep): string {
  const gateway = (step.gateway ? gatewayName(step.gateway) : null) ?? 'a Kilo gateway';
  if (step.partner_inference_provider) {
    const partner = inferenceProviderNames([step.partner_inference_provider]);
    return `Paid with Kilo credits, with ${partner} as the direct provider and ${gateway} as the fallback.`;
  }
  return `Paid with Kilo credits and routed through ${gateway}.`;
}

/** A partner route failed over to Kilo's gateway route, which Kilo also pays for. */
export function isPartnerFailover(attempts: readonly { provider_type?: string }[]): boolean {
  return attempts[0]?.provider_type === 'partner';
}

export function inferenceProviderNames(providers: string[]): string {
  return listOf(providers.map(provider => normalizePublicInferenceProvider(provider).name));
}

/** `failedOver`: the selected BYOK key failed and the request moved on to the owner's next key. */
export function describeStep(
  step: RequestLogRoutingStep,
  { failedOver = false }: { failedOver?: boolean } = {}
): DescribedStep {
  const tone = toneOf(step.outcome);
  switch (step.step) {
    case 'local-fake-llm':
      return { title: 'Local fake LLM', detail: 'Served by the local development model.', tone };
    case 'custom-llm':
      return { title: 'Promotional model', detail: describePromotionalModel(step), tone };
    case 'direct-byok-model':
      return {
        title: isPrivateProviderStep(step) ? 'Private provider model ID' : 'Provider model ID',
        detail: describeProviderModelId(step),
        tone,
      };
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
            ? 'Paid by the linked Claude organization.'
            : 'Claude organization billing is unavailable.',
        tone,
      };
    case 'byok-key':
      return { title: 'BYOK keys', detail: describeByokKey(step, failedOver), tone };
    case 'unsupported-api-kind': {
      const key = step.provider_id ? keyLabel([step.provider_id]) : 'BYOK key';
      const supported = step.supported_api_kinds?.map(apiKindLabel).join(' and ');
      return {
        title: 'BYOK key over another API',
        detail: `No key serves this API, so the request went to the ${key}${supported ? `, which supports ${supported}` : ''}.`,
        tone,
      };
    }
    case 'partner':
      return { title: 'Direct provider', detail: describePartnerSkip(step), tone };
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
