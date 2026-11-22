/* eslint-disable max-classes-per-file -- the input and request problem classes share one store contract file, and every consumer imports both names from here */
import { type ApiKind } from '@kilocode/harness-sdk';
import { type RemoteModelConfig } from '@kilocode/harness-sdk/plugins/remote-model';
import { randomUUID } from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { CHAT_BACKENDS_KEY } from '@/lib/storage-keys';

import {
  backendHeadersSchema,
  type BackendInputProblem,
  draftSchema,
  inputProblem,
  storedDraftSchema,
} from './backend-schema';
import { BackendUrlError, normalizeBackendUrl } from './backend-url';

export type { BackendInputProblem } from './backend-schema';

export type BackendModel = {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  tools: boolean;
  /** Image parts are sent only when this is true. */
  images: boolean;
  /** The effort picker is offered, and the effort sent, only when this is true. */
  reasoning: boolean;
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
export const BACKEND_INPUT_ERROR_KEYS = {
  invalidInput: 'modelChat.backends.invalidInput',
  invalidApiKey: 'modelChat.backends.invalidApiKey',
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

export type BackendRequestProblem =
  | 'cancelled'
  | 'timedOut'
  | 'unauthorized'
  | 'notFound'
  | 'rateLimited'
  | 'unavailable'
  | 'unreachable'
  | 'invalidResponse'
  | 'noModels'
  | 'incomplete';

/** Every problem a person can act on. A caller cancel has no copy, because nothing renders it. */
export const BACKEND_REQUEST_ERROR_KEYS = {
  timedOut: 'modelChat.backends.requestTimedOut',
  unauthorized: 'modelChat.backends.requestUnauthorized',
  notFound: 'modelChat.backends.requestNotFound',
  rateLimited: 'modelChat.backends.requestRateLimited',
  unavailable: 'modelChat.backends.requestUnavailable',
  unreachable: 'modelChat.backends.requestUnreachable',
  invalidResponse: 'modelChat.backends.requestInvalidResponse',
  noModels: 'modelChat.backends.discoveryNoModels',
  incomplete: 'modelChat.backends.connectionIncomplete',
} as const satisfies Record<Exclude<BackendRequestProblem, 'cancelled'>, string>;

export class BackendRequestError extends Error {
  readonly problem: BackendRequestProblem;

  constructor(problem: BackendRequestProblem) {
    // Provider text can echo authorization headers or API keys, so the message is the problem name.
    super(problem);
    this.problem = problem;
  }
}

export function parseChatBackendHeaders(input: string): ChatBackendDraft['headers'] {
  try {
    const parsed: unknown = JSON.parse(input.trim() || '{}');
    return backendHeadersSchema.parse(parsed);
  } catch {
    throw new BackendInputError('invalidInput');
  }
}

export function validateChatBackendDraft(input: unknown): ChatBackendDraft {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) {
    throw new BackendInputError(inputProblem(parsed.error));
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
    throw new BackendInputError(inputProblem(parsed.error));
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

/** One stored profile read leniently; a structurally wrong one drops alone, never the list. */
function readStoredBackend(item: unknown): StoredChatBackend | null {
  const identity = storedIdentitySchema.safeParse(item);
  const parsed = storedDraftSchema.safeParse(item);
  if (!identity.success || !parsed.success) {
    return null;
  }
  try {
    const baseUrl = normalizeBackendUrl(parsed.data.baseUrl, parsed.data.allowLocalHttp);
    return freezeBackend({ ...parsed.data, baseUrl, ...identity.data });
  } catch {
    // Drop only the invalid profile, without reporting secret-bearing data.
    return null;
  }
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
      const backend = readStoredBackend(item);
      if (backend !== null && !ids.has(backend.id)) {
        ids.add(backend.id);
        profiles.push(backend);
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

export const listChatBackends = store.getRequested;
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
  const profiles = [...store.getRequested(), backend];
  Object.freeze(profiles);
  store.set(profiles);
  return backend;
}

export function updateChatBackend(id: string, draft: ChatBackendDraft): StoredChatBackend {
  if (!store.getHasLoaded()) {
    throw new BackendInputError('notLoaded');
  }
  const profiles = store.getRequested();
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
  const profiles = store.getRequested().filter(profile => profile.id !== id);
  Object.freeze(profiles);
  store.set(profiles);
}

export function clearChatBackends(): void {
  store.clear();
}

export function useChatBackends(): StoredChatBackend[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
