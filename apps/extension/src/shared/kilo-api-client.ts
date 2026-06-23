import { z } from 'zod';
import type { FetchLike } from './auth';
export {
  fetchKiloGatewayChatCompletionStream,
  parseKiloGatewayChatCompletionStream,
} from './kilo-gateway-chat-stream-client';
export type {
  KiloGatewayChatCompletion,
  KiloGatewayChatMessage,
  KiloGatewayChatToolCall,
  KiloGatewayToolCallRequest,
  KiloGatewayToolDefinition,
  KiloGatewayToolName,
} from './kilo-gateway-chat-client';

export interface KiloGatewayModelOption {
  readonly hasUserByokAvailable?: boolean;
  readonly id: string;
  readonly isFree?: boolean;
  readonly isPreferred: boolean;
  readonly mayTrainOnYourPrompts?: boolean;
  readonly name: string;
  readonly supportsImages?: boolean;
  readonly variants: string[];
}

export interface KiloOrganizationOption {
  readonly id: string;
  readonly name: string;
}

interface FetchKiloGatewayModelsOptions {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  readonly organizationId?: string | undefined;
  readonly signal?: AbortSignal;
  readonly token: string;
}

interface FetchKiloOrganizationsOptions {
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
  supportsImages?: boolean;
  variants: string[];
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
const nonEmptyStringSchema = z.string().min(1);
const modelSchema = z.object({
  architecture: z
    .object({
      input_modalities: z.array(z.string()).optional(),
    })
    .optional(),
  hasUserByokAvailable: z.boolean().optional(),
  id: nonEmptyStringSchema,
  isFree: z.boolean().optional(),
  mayTrainOnYourPrompts: z.boolean().optional(),
  name: nonEmptyStringSchema,
  opencode: z
    .object({
      variants: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  preferredIndex: z.number().optional(),
});
const gatewayModelsResponseSchema = z.object({
  data: z.array(z.unknown()),
});
const organizationSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
});
const organizationsResponseSchema = z.object({
  organizations: z.array(z.unknown()),
});

const formatShortModelName = (name: string): string => {
  const colonIndex = name.indexOf(': ');
  return colonIndex === -1 ? name : name.slice(colonIndex + 2);
};

const organizationHeaderName = 'x-kilocode-organizationid';

const withOrganizationHeader = (
  headers: Record<string, string>,
  organizationId: string | undefined
): Record<string, string> =>
  organizationId === undefined || organizationId === ''
    ? headers
    : { ...headers, [organizationHeaderName]: organizationId };

const getModelVariants = (model: z.infer<typeof modelSchema>): string[] =>
  Object.keys(model.opencode?.variants ?? {});

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
    supportsImages?: boolean;
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

  if (model.supportsImages !== undefined) {
    option.supportsImages = model.supportsImages;
  }

  return option;
};

export const parseKiloGatewayModelsResponse = (value: unknown): KiloGatewayModelOption[] => {
  const parsed = gatewayModelsResponseSchema.safeParse(value);

  if (!parsed.success) {
    throw new TypeError('Gateway models response did not include a model list.');
  }

  return parsed.data.data
    .flatMap(candidate => {
      const model = modelSchema.safeParse(candidate);

      if (!model.success) {
        return [];
      }

      const option: ParsedGatewayModelOption = {
        id: model.data.id,
        isPreferred: model.data.preferredIndex !== undefined,
        name: formatShortModelName(model.data.name),
        variants: getModelVariants(model.data),
        ...(model.data.hasUserByokAvailable === undefined
          ? {}
          : { hasUserByokAvailable: model.data.hasUserByokAvailable }),
        ...(model.data.isFree === undefined ? {} : { isFree: model.data.isFree }),
        ...(model.data.mayTrainOnYourPrompts === undefined
          ? {}
          : { mayTrainOnYourPrompts: model.data.mayTrainOnYourPrompts }),
        ...(model.data.preferredIndex === undefined
          ? {}
          : { preferredIndex: model.data.preferredIndex }),
        ...(model.data.architecture?.input_modalities?.includes('image') === true
          ? { supportsImages: true }
          : {}),
      };

      return [option];
    })
    .toSorted(compareModelOptions)
    .map(model => toGatewayModelOption(model));
};

export const parseKiloOrganizationsResponse = (value: unknown): KiloOrganizationOption[] => {
  const parsed = organizationsResponseSchema.safeParse(value);

  if (!parsed.success) {
    throw new TypeError('Organizations response did not include a list.');
  }

  return parsed.data.organizations.flatMap(candidate => {
    const organization = organizationSchema.safeParse(candidate);

    return organization.success ? [organization.data] : [];
  });
};

export const fetchKiloGatewayModels = async ({
  apiBaseUrl,
  fetch,
  organizationId,
  signal,
  token,
}: FetchKiloGatewayModelsOptions): Promise<KiloGatewayModelOption[]> => {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/gateway/models`, {
    headers: withOrganizationHeader(
      {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      organizationId
    ),
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch gateway models: ${response.status}`);
  }

  const data: unknown = await response.json();
  return parseKiloGatewayModelsResponse(data);
};

export const fetchKiloOrganizations = async ({
  apiBaseUrl,
  fetch,
  signal,
  token,
}: FetchKiloOrganizationsOptions): Promise<KiloOrganizationOption[]> => {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/organizations`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch organizations: ${response.status}`);
  }

  const data: unknown = await response.json();
  return parseKiloOrganizationsResponse(data);
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
