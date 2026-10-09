import { i18n } from '@/i18n';

import { type BackendModel, type StoredChatBackend } from './backend-store';

const PREFIX = 'backend:';

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
  return error instanceof BackendTargetError
    ? TARGET_ERROR_KEYS[error.problem]
    : 'common.somethingWentWrong';
}

type BackendTarget = {
  readonly backendId: string;
  readonly revision: number;
  readonly modelId: string;
};

export type ResolvedChatTarget =
  | { readonly kind: 'kilo'; readonly modelId: string }
  | {
      readonly kind: 'custom';
      readonly backend: StoredChatBackend;
      readonly model: BackendModel;
      readonly modelId: string;
    };

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
