import type { FetchLike } from './auth';
export {
  fetchKiloGatewayChatCompletion,
  parseKiloGatewayChatCompletionResponse,
} from './kilo-gateway-chat-client';
export type {
  KiloGatewayChatCompletion,
  KiloGatewayChatMessage,
  KiloGatewayChatToolCall,
  KiloGatewayEvalToolCall,
  KiloGatewayToolDefinition,
} from './kilo-gateway-chat-client';

export interface KiloGatewayModelOption {
  readonly hasUserByokAvailable?: boolean;
  readonly id: string;
  readonly isFree?: boolean;
  readonly isPreferred: boolean;
  readonly mayTrainOnYourPrompts?: boolean;
  readonly name: string;
  readonly variants: string[];
}

interface FetchKiloGatewayModelsOptions {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  readonly signal?: AbortSignal;
  readonly token: string;
}

interface ParsedGatewayModelOption {
  hasUserByokAvailable?: boolean;
  id: string;
  isFree?: boolean;
  isPreferred: boolean;
  mayTrainOnYourPrompts?: boolean;
  name: string;
  preferredIndex?: number;
  variants: string[];
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getOptionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const getOptionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const getOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const formatShortModelName = (name: string): string => {
  const colonIndex = name.indexOf(': ');
  return colonIndex === -1 ? name : name.slice(colonIndex + 2);
};

const getModelVariants = (model: Record<string, unknown>): string[] => {
  const { opencode } = model;

  if (!isRecord(opencode)) {
    return [];
  }

  const { variants } = opencode;

  return isRecord(variants) ? Object.keys(variants) : [];
};

const compareModelOptions = (
  left: ParsedGatewayModelOption,
  right: ParsedGatewayModelOption
): number => {
  const leftIsPreferred = left.preferredIndex !== undefined;
  const rightIsPreferred = right.preferredIndex !== undefined;

  if (leftIsPreferred && rightIsPreferred) {
    return (left.preferredIndex ?? 0) - (right.preferredIndex ?? 0);
  }

  if (leftIsPreferred) {
    return -1;
  }

  if (rightIsPreferred) {
    return 1;
  }

  return left.name.localeCompare(right.name);
};

const toGatewayModelOption = (model: ParsedGatewayModelOption): KiloGatewayModelOption => {
  const option: {
    hasUserByokAvailable?: boolean;
    id: string;
    isFree?: boolean;
    isPreferred: boolean;
    mayTrainOnYourPrompts?: boolean;
    name: string;
    variants: string[];
  } = {
    id: model.id,
    isPreferred: model.isPreferred,
    name: model.name,
    variants: model.variants,
  };

  if (model.hasUserByokAvailable !== undefined) {
    option.hasUserByokAvailable = model.hasUserByokAvailable;
  }

  if (model.isFree !== undefined) {
    option.isFree = model.isFree;
  }

  if (model.mayTrainOnYourPrompts !== undefined) {
    option.mayTrainOnYourPrompts = model.mayTrainOnYourPrompts;
  }

  return option;
};

export const parseKiloGatewayModelsResponse = (value: unknown): KiloGatewayModelOption[] => {
  if (!isRecord(value) || !Array.isArray(value['data'])) {
    throw new TypeError('Gateway models response did not include a model list.');
  }

  return value['data']
    .flatMap(model => {
      if (!isRecord(model)) {
        return [];
      }

      const id = getOptionalString(model['id']);
      const name = getOptionalString(model['name']);

      if (id === undefined || name === undefined) {
        return [];
      }

      const hasUserByokAvailable = getOptionalBoolean(model['hasUserByokAvailable']);
      const isFree = getOptionalBoolean(model['isFree']);
      const mayTrainOnYourPrompts = getOptionalBoolean(model['mayTrainOnYourPrompts']);
      const preferredIndex = getOptionalNumber(model['preferredIndex']);
      const option: ParsedGatewayModelOption = {
        id,
        isPreferred: preferredIndex !== undefined,
        name: formatShortModelName(name),
        variants: getModelVariants(model),
        ...(hasUserByokAvailable === undefined ? {} : { hasUserByokAvailable }),
        ...(isFree === undefined ? {} : { isFree }),
        ...(mayTrainOnYourPrompts === undefined ? {} : { mayTrainOnYourPrompts }),
        ...(preferredIndex === undefined ? {} : { preferredIndex }),
      };

      return [option];
    })
    .toSorted(compareModelOptions)
    .map(model => toGatewayModelOption(model));
};

export const fetchKiloGatewayModels = async ({
  apiBaseUrl,
  fetch,
  signal,
  token,
}: FetchKiloGatewayModelsOptions): Promise<KiloGatewayModelOption[]> => {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/gateway/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch gateway models: ${response.status}`);
  }

  const data: unknown = await response.json();
  return parseKiloGatewayModelsResponse(data);
};

export const thinkingEffortLabel = (variant: string): string => {
  switch (variant) {
    case 'medium': {
      return 'Med';
    }
    case 'minimal': {
      return 'Min';
    }
    case 'xhigh': {
      return 'XHigh';
    }
    default: {
      return variant.charAt(0).toUpperCase() + variant.slice(1);
    }
  }
};
