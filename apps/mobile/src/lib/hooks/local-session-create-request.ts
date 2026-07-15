import { type inferRouterInputs, type RootRouter } from '@kilocode/trpc';

import { type LocalRuntimeCatalog, type LocalRuntimeFence } from './local-runtime-catalog-types';

type RouterInputs = inferRouterInputs<RootRouter>;

export type LocalSessionCreateModelSelection = {
  providerID: string;
  modelID: string;
  variant: string;
};

export type LocalSessionCreateAgentSelection = {
  slug: string;
  name: string;
};

export type BuildLocalSessionCreateRequestInput = {
  fence: LocalRuntimeFence;
  catalog: LocalRuntimeCatalog;
  selectedAgentSlug: string;
  selectedModel: LocalSessionCreateModelSelection;
  prompt: string;
  requestId: string;
};

export type BuiltLocalSessionCreateRequest = RouterInputs['localRuntimeControl']['createAndRun'];

const PROMPT_MIN = 1;
const PROMPT_MAX = 32_768;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Pure builder for the wire payload the orchestrator hands to
 * `trpcClient.localRuntimeControl.createAndRun.mutate`. Every field on the
 * returned object is derived strictly from the input — no `Crypto.randomUUID`
 * is invoked here, no default agent fallback, no trimming logic, no
 * attachments. The function is the only place the create request shape is
 * built; the orchestrator is responsible for the requestId it passes in.
 *
 * The function throws a `LocalSessionCreateRequestError` with a precise
 * machine-readable code when any input is unusable, so the orchestrator can
 * map a builder failure to the same upstream-error classifier used for tRPC
 * failures (e.g. a stale `selectedAgentSlug` collapses to the
 * `catalog-changed` branch, not a generic client error).
 */
export function buildLocalSessionCreateRequest(
  input: BuildLocalSessionCreateRequestInput
): BuiltLocalSessionCreateRequest {
  validateFence(input.fence);
  validateRequestId(input.requestId);
  validateCatalogContents(input.catalog);
  validateSelection(input.catalog, input.selectedAgentSlug, input.selectedModel);
  const trimmed = input.prompt.trim();
  validatePrompt(trimmed);

  const baseRequest = {
    protocolVersion: 1 as const,
    requestId: input.requestId,
    prompt: trimmed,
    model: {
      providerID: input.selectedModel.providerID,
      modelID: input.selectedModel.modelID,
    },
    agent: input.selectedAgentSlug,
  };
  const variant = input.selectedModel.variant;
  const request: BuiltLocalSessionCreateRequest['request'] = variant
    ? { ...baseRequest, variant }
    : baseRequest;
  return {
    fence: {
      runtimeId: input.fence.runtimeId,
      connectionId: input.fence.connectionId,
    },
    request,
  };
}

type LocalSessionCreateRequestErrorCode =
  | 'invalid-fence'
  | 'invalid-request-id'
  | 'invalid-catalog'
  | 'invalid-agent'
  | 'invalid-model'
  | 'invalid-prompt-empty'
  | 'invalid-prompt-too-long';

export class LocalSessionCreateRequestError extends Error {
  readonly code: LocalSessionCreateRequestErrorCode;

  constructor(code: LocalSessionCreateRequestErrorCode, message: string) {
    super(message);
    this.name = 'LocalSessionCreateRequestError';
    this.code = code;
  }
}

function validateFence(fence: LocalRuntimeFence) {
  if (typeof fence.runtimeId !== 'string' || fence.runtimeId.length === 0) {
    throw new LocalSessionCreateRequestError('invalid-fence', 'runtimeId is required');
  }
  if (typeof fence.connectionId !== 'string' || fence.connectionId.length === 0) {
    throw new LocalSessionCreateRequestError('invalid-fence', 'connectionId is required');
  }
  if (!UUID_PATTERN.test(fence.runtimeId)) {
    throw new LocalSessionCreateRequestError('invalid-fence', 'runtimeId must be a UUID');
  }
}

function validateRequestId(requestId: string) {
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new LocalSessionCreateRequestError('invalid-request-id', 'requestId is required');
  }
  if (!UUID_PATTERN.test(requestId)) {
    throw new LocalSessionCreateRequestError('invalid-request-id', 'requestId must be a UUID');
  }
}

function validateCatalogContents(catalog: LocalRuntimeCatalog) {
  if (!catalog.defaultAgent) {
    throw new LocalSessionCreateRequestError('invalid-catalog', 'catalog.defaultAgent is required');
  }
  if (!Array.isArray(catalog.agents) || catalog.agents.length === 0) {
    throw new LocalSessionCreateRequestError('invalid-catalog', 'catalog.agents must be non-empty');
  }
  if (
    !Array.isArray(catalog.models.providers) ||
    catalog.models.providers.length === 0 ||
    catalog.models.providers.every(p => !Array.isArray(p.models) || p.models.length === 0)
  ) {
    throw new LocalSessionCreateRequestError('invalid-catalog', 'catalog.models must be non-empty');
  }
}

function validateSelection(
  catalog: LocalRuntimeCatalog,
  selectedAgentSlug: string,
  selectedModel: LocalSessionCreateModelSelection
) {
  if (typeof selectedAgentSlug !== 'string' || selectedAgentSlug.length === 0) {
    throw new LocalSessionCreateRequestError('invalid-agent', 'selectedAgentSlug is required');
  }
  const agent = catalog.agents.find(a => a.slug === selectedAgentSlug);
  if (!agent) {
    throw new LocalSessionCreateRequestError(
      'invalid-agent',
      `selectedAgentSlug "${selectedAgentSlug}" is not present in the catalog`
    );
  }
  if (typeof selectedModel.providerID !== 'string' || selectedModel.providerID.length === 0) {
    throw new LocalSessionCreateRequestError('invalid-model', 'providerID is required');
  }
  if (typeof selectedModel.modelID !== 'string' || selectedModel.modelID.length === 0) {
    throw new LocalSessionCreateRequestError('invalid-model', 'modelID is required');
  }
  const provider = catalog.models.providers.find(p => p.id === selectedModel.providerID);
  const model = provider?.models.find(m => m.id === selectedModel.modelID);
  if (!model) {
    throw new LocalSessionCreateRequestError(
      'invalid-model',
      `model "${selectedModel.providerID}/${selectedModel.modelID}" is not present in the catalog`
    );
  }
  if (selectedModel.variant.length > 0 && !model.variants.includes(selectedModel.variant)) {
    throw new LocalSessionCreateRequestError(
      'invalid-model',
      `variant "${selectedModel.variant}" is not offered by the selected model`
    );
  }
}

function validatePrompt(prompt: string) {
  if (prompt.length < PROMPT_MIN) {
    throw new LocalSessionCreateRequestError(
      'invalid-prompt-empty',
      'Enter a prompt to start the session.'
    );
  }
  if (prompt.length > PROMPT_MAX) {
    throw new LocalSessionCreateRequestError(
      'invalid-prompt-too-long',
      'Prompt must be 32,768 characters or fewer. Shorten the prompt and try again.'
    );
  }
}
