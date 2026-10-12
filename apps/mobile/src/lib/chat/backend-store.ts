import { type ApiKind } from '@kilocode/harness-sdk';
import { type RemoteModelConfig } from '@kilocode/harness-sdk/plugins/remote-model';
import { randomUUID } from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { CHAT_BACKENDS_KEY } from '@/lib/storage-keys';

import { BackendUrlError, hasControlCharacters, normalizeBackendUrl } from './backend-url';

export type BackendModel = {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  tools: boolean;
  /** Image parts are sent only when this is true. */
  images: boolean;
};
export type StoredChatBackend = {
  id: string;
  revision: number;
  name: string;
  baseUrl: string;
  apiKind: ApiKind;
  completionTokenField?: RemoteModelConfig['completionTokenField'];
  apiKey: string;
  headers: Record<string, string>;
  models: BackendModel[];
  allowLocalHttp: boolean;
};
export type ChatBackendDraft = Omit<StoredChatBackend, 'id' | 'revision'>;
export type BackendInputProblem =
  | 'invalidInput'
  | 'invalidUrl'
  | 'publicHttp'
  | 'httpApprovalRequired'
  | 'httpReleaseUnavailable'
  | 'staleBackend'
  | 'notLoaded';

export const BACKEND_INPUT_ERROR_KEYS = {
  invalidInput: 'modelChat.backends.invalidInput',
  invalidUrl: 'modelChat.backends.invalidUrl',
  publicHttp: 'modelChat.backends.publicHttp',
  httpApprovalRequired: 'modelChat.backends.httpApprovalRequired',
  httpReleaseUnavailable: 'modelChat.backends.httpReleaseUnavailable',
  staleBackend: 'modelChat.backends.staleBackend',
  notLoaded: 'modelChat.backends.notLoaded',
} as const satisfies Record<BackendInputProblem, string>;

export class BackendInputError extends Error {
  readonly problem: BackendInputProblem;

  constructor(problem: BackendInputProblem) {
    // Never expose Zod issues: they may include a credential or custom header.
    super(problem);
    this.problem = problem;
  }
}

const backendModelSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .refine(value => !hasControlCharacters(value)),
    name: z.string().trim().min(1),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    tools: z.boolean(),
    // A profile stored before the flag existed reads as text-only.
    images: z.boolean().default(false),
  })
  .strip();

const backendHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) ||
      !/^[\u0020-\u007E\u0080-\u00FF]*$/.test(value) ||
      lower.startsWith('x-kilo') ||
      [
        'host',
        'content-length',
        'content-type',
        'connection',
        'transfer-encoding',
        'proxy-authorization',
        '__proto__',
        'constructor',
        'prototype',
      ].includes(lower) ||
      names.has(lower)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid headers' });
    }
    names.add(lower);
  }
});

export function parseChatBackendHeaders(input: string): ChatBackendDraft['headers'] {
  try {
    const parsed: unknown = JSON.parse(input.trim() || '{}');
    return backendHeadersSchema.parse(parsed);
  } catch {
    throw new BackendInputError('invalidInput');
  }
}

const draftSchema = z
  .object({
    name: z.string().trim().min(1),
    baseUrl: z.string(),
    apiKind: z.enum(['chat_completions', 'responses', 'messages']),
    completionTokenField: z
      .enum(['max_completion_tokens', 'max_tokens'])
      .default('max_completion_tokens'),
    apiKey: z.string().refine(value => /^[\u0020-\u007E\u0080-\u00FF]*$/.test(value)),
    headers: backendHeadersSchema,
    models: z
      .array(backendModelSchema)
      .min(1)
      .refine(models => new Set(models.map(model => model.id)).size === models.length),
    allowLocalHttp: z.boolean(),
  })
  .strip();

export function validateChatBackendDraft(input: unknown): ChatBackendDraft {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) {
    throw new BackendInputError('invalidInput');
  }
  try {
    return {
      ...parsed.data,
      baseUrl: normalizeBackendUrl(parsed.data.baseUrl, parsed.data.allowLocalHttp),
    };
  } catch (error) {
    throw new BackendInputError(error instanceof BackendUrlError ? error.problem : 'invalidUrl');
  }
}

export type BackendConnection = Pick<
  ChatBackendDraft,
  'baseUrl' | 'apiKind' | 'completionTokenField' | 'apiKey' | 'headers' | 'allowLocalHttp'
>;

export function validateBackendConnection(input: unknown): BackendConnection {
  const parsed = draftSchema.omit({ name: true, models: true }).safeParse(input);
  if (!parsed.success) {
    throw new BackendInputError('invalidInput');
  }
  try {
    return {
      ...parsed.data,
      baseUrl: normalizeBackendUrl(parsed.data.baseUrl, parsed.data.allowLocalHttp),
    };
  } catch (error) {
    throw new BackendInputError(error instanceof BackendUrlError ? error.problem : 'invalidUrl');
  }
}

const storedIdentitySchema = z.object({ id: z.uuid(), revision: z.number().int().positive() });

/** A revision snapshot must never change while a generation holds it. */
function freezeBackend(backend: StoredChatBackend): StoredChatBackend {
  for (const model of backend.models) {
    Object.freeze(model);
  }
  Object.freeze(backend.models);
  Object.freeze(backend.headers);
  return Object.freeze(backend);
}

export function parseChatBackends(raw: string | null): StoredChatBackend[] {
  if (raw === null) {
    return [];
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return [];
    }
    const profiles: StoredChatBackend[] = [];
    const ids = new Set<string>();
    for (const item of data) {
      const identity = storedIdentitySchema.safeParse(item);
      if (identity.success && !ids.has(identity.data.id)) {
        try {
          const draft = validateChatBackendDraft(item);
          profiles.push(freezeBackend({ ...draft, ...identity.data }));
          ids.add(identity.data.id);
        } catch {
          // Drop only the invalid profile, without reporting secret-bearing data.
        }
      }
    }
    Object.freeze(profiles);
    return profiles;
  } catch {
    return [];
  }
}

const emptyBackends: StoredChatBackend[] = [];
Object.freeze(emptyBackends);

const store = createSecureStorePreference<StoredChatBackend[]>({
  key: CHAT_BACKENDS_KEY,
  defaultValue: emptyBackends,
  parse: parseChatBackends,
  serialize: value => JSON.stringify(value),
});
store.preload();

export const listChatBackends = store.get;
export const subscribeChatBackends = store.subscribe;
export const getChatBackendsHasLoaded = store.getHasLoaded;
export const waitForChatBackends = store.whenLoaded;

export function addChatBackend(draft: ChatBackendDraft): StoredChatBackend {
  if (!store.getHasLoaded()) {
    throw new BackendInputError('notLoaded');
  }
  const backend = freezeBackend({
    ...validateChatBackendDraft(draft),
    id: randomUUID(),
    revision: 1,
  });
  const profiles = [...store.get(), backend];
  Object.freeze(profiles);
  store.set(profiles);
  return backend;
}

export function updateChatBackend(id: string, draft: ChatBackendDraft): StoredChatBackend {
  if (!store.getHasLoaded()) {
    throw new BackendInputError('notLoaded');
  }
  const profiles = store.get();
  const previous = profiles.find(profile => profile.id === id);
  if (!previous || previous.revision >= Number.MAX_SAFE_INTEGER) {
    throw new BackendInputError('staleBackend');
  }
  const backend = freezeBackend({
    ...validateChatBackendDraft(draft),
    id,
    revision: previous.revision + 1,
  });
  const next = profiles.map(profile => (profile.id === id ? backend : profile));
  Object.freeze(next);
  store.set(next);
  return backend;
}

export function deleteChatBackend(id: string): void {
  if (!store.getHasLoaded()) {
    throw new BackendInputError('notLoaded');
  }
  const profiles = store.get().filter(profile => profile.id !== id);
  Object.freeze(profiles);
  store.set(profiles);
}

export function clearChatBackends(): void {
  store.clear();
}

export function useChatBackends(): StoredChatBackend[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
