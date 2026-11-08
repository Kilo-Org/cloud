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

const GATEWAY_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter',
  vercel: 'Vercel AI Gateway',
  'claude-billing': 'Claude API',
};

const BYOK_ROUTE_LABELS: Record<string, string> = {
  'direct-byok': 'directly to the provider',
  'vercel-byok': 'through the Vercel AI Gateway',
  'gateway-byok': 'through its own gateway account',
};

export const BYOK_SKIP_REASON_LABELS: Record<string, string> = {
  'unsupported-api-kind': 'Does not support this API',
  disabled: 'Key disabled',
  'not-catalog-mode': 'Key does not serve catalog models',
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
  'custom-llm-credential': 'Custom model credential',
  'owner-byok-key': 'BYOK key',
  'chatgpt-subscription': 'ChatGPT subscription',
  'customer-claude-organization': 'Claude organization',
  kilo: 'Kilo credits',
};

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  vercel: 'Vercel AI Gateway',
  'direct-byok': 'Direct BYOK',
  inception: 'Inception',
  mistral: 'Mistral',
  'openai-chatgpt': 'ChatGPT',
  'claude-billing': 'Claude organization',
  custom: 'Custom model',
  'custom-public': 'Public custom model',
  'dev-tools': 'Development tools',
};

const REJECTED_RESULT_LABELS: Record<string, string> = {
  'chatgpt-reconnect': 'Rejected: the ChatGPT connection must be reconnected',
  'claude-billing-unavailable': 'Rejected: Claude organization billing is unavailable',
  'custom-llm-unavailable': 'Rejected: the custom model is unavailable',
  'direct-byok-catalog-only': 'Rejected: this model is only available through the catalog',
};

const CUSTOM_LLM_REJECTION_LABELS: Record<string, string> = {
  'country-denied': 'Requests from this country are not allowed for this custom model.',
  'not-eligible': 'The caller is not eligible for this custom model.',
  'invalid-credentials': "The custom model's credentials could not be used.",
};

function lookup(labels: Record<string, string>, value: string): string {
  return Object.hasOwn(labels, value) ? labels[value] : value;
}

export function gatewayName(gateway: string): string {
  return lookup(GATEWAY_NAMES, gateway);
}

export function payerLabel(payer: string): string {
  return lookup(PAYER_LABELS, payer);
}

export function providerTypeLabel(providerType: string): string {
  return lookup(PROVIDER_TYPE_LABELS, providerType);
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

function describeCustomLlm(step: RequestLogRoutingStep): string {
  if (step.outcome === 'selected') {
    return `Matched a ${step.visibility ? `${step.visibility} ` : ''}custom model.`;
  }
  if (step.outcome === 'rejected' && step.reason) {
    return lookup(CUSTOM_LLM_REJECTION_LABELS, step.reason);
  }
  return 'No custom model matches the requested model.';
}

function describeDirectByokModel(step: RequestLogRoutingStep): string {
  const provider = step.provider_id ?? 'the provider';
  if (step.outcome === 'selected') return `Served with the ${provider} key.`;
  if (step.outcome === 'rejected') {
    return step.catalog_model_id
      ? `The ${provider} key only serves catalog models; use ${step.catalog_model_id}.`
      : `The ${provider} key only serves catalog models.`;
  }
  if (step.reason === 'no-key') return `No ${provider} key is configured.`;
  return 'The requested model is not a direct BYOK model.';
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
    const route = step.route ? ` ${lookup(BYOK_ROUTE_LABELS, step.route)}` : '';
    return `Served with the ${step.provider_id ?? ''} key${route}.`;
  }
  return step.reason === 'none-served'
    ? 'None of the BYOK keys could serve the request.'
    : 'No BYOK key can serve this model.';
}

function describeKilo(step: RequestLogRoutingStep): string {
  const gateway = step.gateway ? gatewayName(step.gateway) : 'a Kilo gateway';
  return `Paid with Kilo credits and routed through ${gateway}.`;
}

export function describeStep(step: RequestLogRoutingStep): DescribedStep {
  const tone = toneOf(step.outcome);
  switch (step.step) {
    case 'local-fake-llm':
      return { title: 'Local fake LLM', detail: 'Served by the local development model.', tone };
    case 'custom-llm':
      return { title: 'Custom model', detail: describeCustomLlm(step), tone };
    case 'direct-byok-model':
      return { title: 'Direct BYOK model', detail: describeDirectByokModel(step), tone };
    case 'organization-policy': {
      const excluded = step.excluded_provider_ids ?? [];
      return {
        title: 'Organization policy',
        detail:
          excluded.length > 0
            ? `Excluded BYOK providers: ${excluded.join(', ')}.`
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
      const supported = step.supported_api_kinds?.join(', ');
      return {
        title: 'BYOK key over another API',
        detail: `No key serves this API, so the request went to the ${step.provider_id ?? ''} key${supported ? `, which supports ${supported}` : ''}.`,
        tone,
      };
    }
    case 'kilo':
      return { title: 'Kilo gateway', detail: describeKilo(step), tone };
    default:
      return {
        title: step.step,
        detail: [step.outcome, step.reason].filter(Boolean).join(': '),
        tone,
      };
  }
}
