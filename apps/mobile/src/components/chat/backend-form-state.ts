import { type ApiKind } from '@kilocode/harness-sdk';
import { randomUUID } from 'expo-crypto';

import {
  type BackendConnection,
  type BackendModel,
  type ChatBackendDraft,
  parseChatBackendHeaders,
  validateBackendConnection,
  validateChatBackendDraft,
} from '@/lib/chat/backend-store';

export const API_KINDS = {
  chat_completions: 'modelChat.backends.chatCompletions',
  responses: 'modelChat.backends.responses',
  messages: 'modelChat.backends.messages',
} as const satisfies Record<ApiKind, string>;

export type BackendModelFields = {
  key: string;
  id: string;
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  tools: boolean;
};
export type BackendFormFields = {
  name: string;
  baseUrl: string;
  apiKey: string;
  headers: string;
  apiKind: ApiKind;
  completionTokenField: NonNullable<ChatBackendDraft['completionTokenField']>;
  models: BackendModelFields[];
};

export function modelFields(model?: BackendModel): BackendModelFields {
  return {
    key: randomUUID(),
    id: model?.id ?? '',
    name: model?.name ?? '',
    contextWindow: model?.contextWindow?.toString() ?? '',
    maxOutputTokens: model?.maxOutputTokens?.toString() ?? '',
    tools: model?.tools ?? false,
  };
}

function optionalTokenLimit(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed === '') {
    return undefined;
  }
  return /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
}

export function backendDraftFromFields(
  fields: BackendFormFields,
  allowLocalHttp: boolean
): ChatBackendDraft {
  const headers = parseChatBackendHeaders(fields.headers);
  const models = fields.models.map(model => ({
    id: model.id,
    name: model.name,
    tools: model.tools,
    contextWindow: optionalTokenLimit(model.contextWindow),
    maxOutputTokens: optionalTokenLimit(model.maxOutputTokens),
  }));
  return validateChatBackendDraft({ ...fields, headers, models, allowLocalHttp });
}

export function backendConnectionFromFields(
  fields: BackendFormFields,
  allowLocalHttp: boolean
): BackendConnection {
  const headers = parseChatBackendHeaders(fields.headers);
  return validateBackendConnection({ ...fields, headers, allowLocalHttp });
}
