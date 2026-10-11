import { ModelError } from '@kilocode/harness-sdk';

import { i18n } from '@/i18n';

import { type BackendModel, type StoredChatBackend } from './backend-store';
import { LocalModelError } from './local-model-error';

const PREFIX = 'backend:';
const LOCAL_PREFIX = 'local:';
const GGUF_PREFIX = 'gguf:';
/** A system provider serves one model, and the OS chooses its version. */
const SYSTEM_MODEL = 'system';

type BackendTargetProblem = 'invalidTarget' | 'deletedBackend' | 'staleBackend' | 'missingModel';

const TARGET_ERROR_KEYS = {
  invalidTarget: 'modelChat.backends.invalidTarget',
  deletedBackend: 'modelChat.backends.deletedBackend',
  staleBackend: 'modelChat.backends.staleBackend',
  missingModel: 'modelChat.backends.missingModel',
} as const satisfies Record<BackendTargetProblem, string>;

class BackendTargetError extends Error {
  readonly problem: BackendTargetProblem;

  constructor(problem: BackendTargetProblem) {
    super(i18n.t(TARGET_ERROR_KEYS[problem]));
    this.problem = problem;
  }
}

/** Fixed UI copy only: provider failures may contain credentials or response bodies. */
export function backendFailureKey(error: unknown): string {
  // The routed model client reports target and local failures as a ModelError cause.
  for (const failure of [error, error instanceof ModelError ? error.cause : undefined]) {
    if (failure instanceof BackendTargetError) {
      return TARGET_ERROR_KEYS[failure.problem];
    }
    if (failure instanceof LocalModelError) {
      return failure.key;
    }
  }
  return 'common.somethingWentWrong';
}

type BackendTarget = {
  readonly backendId: string;
  readonly revision: number;
  readonly modelId: string;
};

export type LocalProvider = 'apple' | 'android' | 'gguf';

type LocalTarget = {
  readonly provider: LocalProvider;
  /** `system` for the OS model providers, or the decoded GGUF file id. */
  readonly modelId: string;
};

export type ResolvedChatTarget =
  | { readonly kind: 'kilo'; readonly modelId: string }
  | {
      readonly kind: 'custom';
      readonly backend: StoredChatBackend;
      readonly model: BackendModel;
      readonly modelId: string;
    }
  | ({ readonly kind: 'local' } & LocalTarget);

/** `local:apple`, `local:android`, or `local:gguf:<encodeURIComponent(fileId)>`. */
export function localTargetId(provider: 'apple' | 'android'): string;
export function localTargetId(provider: 'gguf', fileId: string): string;
export function localTargetId(provider: LocalProvider, fileId?: string): string {
  return provider === 'gguf'
    ? `${LOCAL_PREFIX}${GGUF_PREFIX}${encodeURIComponent(fileId ?? '')}`
    : `${LOCAL_PREFIX}${provider}`;
}

function decodedFileId(encoded: string): string | null {
  try {
    const fileId = decodeURIComponent(encoded);
    // One spelling per file, so one file is exactly one backend identity.
    return fileId !== '' && encodeURIComponent(fileId) === encoded ? fileId : null;
  } catch {
    return null;
  }
}

export function decodeLocalTarget(id: string): LocalTarget | null {
  if (!id.startsWith(LOCAL_PREFIX)) {
    return null;
  }
  const rest = id.slice(LOCAL_PREFIX.length);
  if (rest === 'apple' || rest === 'android') {
    return { provider: rest, modelId: SYSTEM_MODEL };
  }
  const fileId = rest.startsWith(GGUF_PREFIX)
    ? decodedFileId(rest.slice(GGUF_PREFIX.length))
    : null;
  if (fileId === null) {
    throw new BackendTargetError('invalidTarget');
  }
  return { provider: 'gguf', modelId: fileId };
}

/** The SDK persists this opaque identity in its existing model field. */
export function backendTargetId(backend: StoredChatBackend, modelId: string): string {
  return `${PREFIX}${encodeURIComponent(backend.id)}:${backend.revision}:${encodeURIComponent(modelId)}`;
}

export function decodeBackendTarget(id: string): BackendTarget | null {
  if (!id.startsWith(PREFIX)) {
    return null;
  }
  const pieces = id.slice(PREFIX.length).split(':');
  const [backendId, revision, modelId] = pieces;
  if (
    pieces.length !== 3 ||
    backendId === undefined ||
    modelId === undefined ||
    revision === undefined ||
    !/^[1-9]\d*$/u.test(revision)
  ) {
    throw new BackendTargetError('invalidTarget');
  }
  try {
    const target = {
      backendId: decodeURIComponent(backendId),
      revision: Number(revision),
      modelId: decodeURIComponent(modelId),
    };
    if (
      target.backendId === '' ||
      target.modelId === '' ||
      !Number.isSafeInteger(target.revision)
    ) {
      throw new Error('Invalid target');
    }
    return target;
  } catch {
    throw new BackendTargetError('invalidTarget');
  }
}

export function resolveChatTarget(
  id: string,
  backends: readonly StoredChatBackend[]
): ResolvedChatTarget {
  const local = decodeLocalTarget(id);
  if (local !== null) {
    return { kind: 'local', ...local };
  }
  const target = decodeBackendTarget(id);
  if (target === null) {
    return { kind: 'kilo', modelId: id };
  }
  const backend = backends.find(one => one.id === target.backendId);
  if (backend === undefined) {
    throw new BackendTargetError('deletedBackend');
  }
  if (backend.revision !== target.revision) {
    throw new BackendTargetError('staleBackend');
  }
  const model = backend.models.find(one => one.id === target.modelId);
  if (model === undefined) {
    throw new BackendTargetError('missingModel');
  }
  return { kind: 'custom', backend, model, modelId: model.id };
}
