import type {
  CloudAgentRootSessionSummary,
  KiloSdkAssistantMessage,
  KiloSdkFilePart,
  KiloSdkMessageInfo,
  KiloSdkPart,
  KiloSdkSessionInfo,
  KiloSdkStoredMessage,
  KiloSdkToolState,
  KiloSdkUserMessage,
} from '../session-ingest-binding.js';

export function publicCloudAgentDirectory(kiloSessionId: string): string {
  return `/cloud-agent/sessions/${kiloSessionId}`;
}

export function projectPublicListedSession(
  summary: CloudAgentRootSessionSummary
): KiloSdkSessionInfo {
  return {
    id: summary.kiloSessionId,
    slug: summary.kiloSessionId,
    projectID: 'cloud-agent',
    directory: publicCloudAgentDirectory(summary.kiloSessionId),
    title: summary.title ?? '',
    version: 'cloud-agent',
    time: { created: summary.created, updated: summary.updated },
  };
}

function isAbsoluteStructuredPath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

function publicPath(path: string, kiloSessionId: string): string {
  return isAbsoluteStructuredPath(path) ? publicCloudAgentDirectory(kiloSessionId) : path;
}

function isPrivateStructuredPath(path: string): boolean {
  return (
    isAbsoluteStructuredPath(path) &&
    path !== '/cloud-agent' &&
    !path.startsWith('/cloud-agent/sessions/')
  );
}

export function projectPublicSession(
  session: KiloSdkSessionInfo,
  kiloSessionId: string
): KiloSdkSessionInfo {
  const projected = { ...session };
  delete projected.path;
  return {
    ...projected,
    directory: publicCloudAgentDirectory(kiloSessionId),
    ...(projected.summary?.diffs
      ? {
          summary: {
            ...projected.summary,
            diffs: projected.summary.diffs.map(diff => ({
              ...diff,
              file: publicPath(diff.file, kiloSessionId),
            })),
          },
        }
      : {}),
    ...(projected.permission
      ? {
          permission: projected.permission.map(rule => ({
            ...rule,
            pattern: publicPath(rule.pattern, kiloSessionId),
          })),
        }
      : {}),
  };
}

function projectPublicUserMessage(
  message: KiloSdkUserMessage,
  kiloSessionId: string
): KiloSdkUserMessage {
  return {
    ...message,
    ...(message.summary
      ? {
          summary: {
            ...message.summary,
            diffs: message.summary.diffs.map(diff => ({
              ...diff,
              file: publicPath(diff.file, kiloSessionId),
            })),
          },
        }
      : {}),
    ...(message.editorContext
      ? {
          editorContext: {
            ...message.editorContext,
            ...(message.editorContext.visibleFiles
              ? {
                  visibleFiles: message.editorContext.visibleFiles.map(file =>
                    publicPath(file, kiloSessionId)
                  ),
                }
              : {}),
            ...(message.editorContext.openTabs
              ? {
                  openTabs: message.editorContext.openTabs.map(file =>
                    publicPath(file, kiloSessionId)
                  ),
                }
              : {}),
            ...(message.editorContext.activeFile
              ? { activeFile: publicPath(message.editorContext.activeFile, kiloSessionId) }
              : {}),
          },
        }
      : {}),
  };
}

function projectPublicAssistantMessage(
  message: KiloSdkAssistantMessage,
  kiloSessionId: string
): KiloSdkAssistantMessage {
  const directory = publicCloudAgentDirectory(kiloSessionId);
  return {
    ...message,
    path: { cwd: directory, root: directory },
  };
}

export function projectPublicMessageInfo(
  message: KiloSdkMessageInfo,
  kiloSessionId: string
): KiloSdkMessageInfo {
  return message.role === 'assistant'
    ? projectPublicAssistantMessage(message, kiloSessionId)
    : projectPublicUserMessage(message, kiloSessionId);
}

function isLocalFileUri(value: string): boolean {
  return /^file:/i.test(value);
}

function publicFilePartUrl(url: string): string {
  return isLocalFileUri(url) ? '' : url;
}

function projectPublicFilePart(part: KiloSdkFilePart, kiloSessionId: string): KiloSdkFilePart {
  const projected = { ...part, url: publicFilePartUrl(part.url) };
  if (!part.source || part.source.type === 'resource') return projected;
  return {
    ...projected,
    source: { ...part.source, path: publicPath(part.source.path, kiloSessionId) },
  };
}

function projectPublicToolState(state: KiloSdkToolState, kiloSessionId: string): KiloSdkToolState {
  if (state.status !== 'completed' || !state.attachments) return state;
  return {
    ...state,
    attachments: state.attachments.map(part => projectPublicFilePart(part, kiloSessionId)),
  };
}

export function projectPublicPart(part: KiloSdkPart, kiloSessionId: string): KiloSdkPart {
  if (part.type === 'file') return projectPublicFilePart(part, kiloSessionId);
  if (part.type === 'tool') {
    return { ...part, state: projectPublicToolState(part.state, kiloSessionId) };
  }
  if (part.type === 'patch') {
    return { ...part, files: part.files.map(file => publicPath(file, kiloSessionId)) };
  }
  return part;
}

export function projectPublicStoredMessage(
  message: KiloSdkStoredMessage,
  kiloSessionId: string
): KiloSdkStoredMessage {
  return {
    info: projectPublicMessageInfo(message.info, kiloSessionId),
    parts: message.parts.map(part => projectPublicPart(part, kiloSessionId)),
  };
}

export function projectPublicStoredMessages(
  messages: KiloSdkStoredMessage[],
  kiloSessionId: string
): KiloSdkStoredMessage[] {
  return messages.map(message => projectPublicStoredMessage(message, kiloSessionId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function projectLooseDiffs(value: unknown, kiloSessionId: string): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((diff: unknown) =>
    isRecord(diff) && typeof diff.file === 'string'
      ? { ...diff, file: publicPath(diff.file, kiloSessionId) }
      : diff
  );
}

function projectLooseSessionInfo(
  info: Record<string, unknown>,
  kiloSessionId: string
): Record<string, unknown> {
  const projected = { ...info };
  delete projected.path;
  return {
    ...projected,
    directory: publicCloudAgentDirectory(kiloSessionId),
    ...(isRecord(projected.summary)
      ? {
          summary: {
            ...projected.summary,
            diffs: projectLooseDiffs(projected.summary.diffs, kiloSessionId),
          },
        }
      : {}),
    ...(Array.isArray(projected.permission)
      ? {
          permission: projected.permission.map((rule: unknown) =>
            isRecord(rule) && typeof rule.pattern === 'string'
              ? { ...rule, pattern: publicPath(rule.pattern, kiloSessionId) }
              : rule
          ),
        }
      : {}),
  };
}

function projectLooseMessageInfo<T extends Record<string, unknown>>(
  info: T,
  kiloSessionId: string
): T {
  if (info.role === 'assistant' && isRecord(info.path)) {
    const directory = publicCloudAgentDirectory(kiloSessionId);
    return { ...info, path: { ...info.path, cwd: directory, root: directory } };
  }
  if (info.role !== 'user') return info;
  return {
    ...info,
    ...(isRecord(info.summary)
      ? {
          summary: {
            ...info.summary,
            diffs: projectLooseDiffs(info.summary.diffs, kiloSessionId),
          },
        }
      : {}),
    ...(isRecord(info.editorContext)
      ? {
          editorContext: {
            ...info.editorContext,
            ...(Array.isArray(info.editorContext.visibleFiles)
              ? {
                  visibleFiles: info.editorContext.visibleFiles.map((file: unknown) =>
                    typeof file === 'string' ? publicPath(file, kiloSessionId) : file
                  ),
                }
              : {}),
            ...(Array.isArray(info.editorContext.openTabs)
              ? {
                  openTabs: info.editorContext.openTabs.map((file: unknown) =>
                    typeof file === 'string' ? publicPath(file, kiloSessionId) : file
                  ),
                }
              : {}),
            ...(typeof info.editorContext.activeFile === 'string'
              ? { activeFile: publicPath(info.editorContext.activeFile, kiloSessionId) }
              : {}),
          },
        }
      : {}),
  };
}

function projectLooseFilePart<T extends Record<string, unknown>>(
  part: T,
  kiloSessionId: string
): T {
  if (part.type !== 'file') return part;
  const projected =
    typeof part.url === 'string' ? { ...part, url: publicFilePartUrl(part.url) } : part;
  if (!isRecord(part.source)) return projected;
  if (
    (part.source.type === 'file' || part.source.type === 'symbol') &&
    typeof part.source.path === 'string'
  ) {
    return {
      ...projected,
      source: { ...part.source, path: publicPath(part.source.path, kiloSessionId) },
    };
  }
  return projected;
}

function projectLoosePart<T extends Record<string, unknown>>(part: T, kiloSessionId: string): T {
  const filePart = projectLooseFilePart(part, kiloSessionId);
  if (filePart.type === 'patch' && Array.isArray(filePart.files)) {
    return {
      ...filePart,
      files: filePart.files.map((file: unknown) =>
        typeof file === 'string' ? publicPath(file, kiloSessionId) : file
      ),
    };
  }
  if (filePart.type !== 'tool' || !isRecord(filePart.state)) return filePart;
  if (filePart.state.status !== 'completed' || !Array.isArray(filePart.state.attachments)) {
    return filePart;
  }
  return {
    ...filePart,
    state: {
      ...filePart.state,
      attachments: filePart.state.attachments.map((attachment: unknown) =>
        isRecord(attachment) ? projectLooseFilePart(attachment, kiloSessionId) : attachment
      ),
    },
  };
}

export type PublicProjectableEvent = {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
};

export function hasUnprojectedPrivateStructuredPath(value: unknown, key?: string): boolean {
  if (typeof value === 'string') {
    return (
      isLocalFileUri(value) ||
      (key !== undefined &&
        ['path', 'directory', 'cwd', 'root', 'file', 'pattern', 'url'].includes(key) &&
        isPrivateStructuredPath(value))
    );
  }
  if (Array.isArray(value)) {
    return value.some(item =>
      hasUnprojectedPrivateStructuredPath(item, key === 'files' ? 'file' : key)
    );
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([childKey, child]) =>
    hasUnprojectedPrivateStructuredPath(child, childKey)
  );
}

function projectSessionEventProperties(
  properties: Record<string, unknown>,
  kiloSessionId: string
): Record<string, unknown> | null {
  const info = properties.info;
  if (!isRecord(info)) return hasUnprojectedPrivateStructuredPath(properties) ? null : properties;
  if (info.id !== kiloSessionId) return null;
  const projected = { ...properties, info: projectLooseSessionInfo(info, kiloSessionId) };
  return hasUnprojectedPrivateStructuredPath(projected) ? null : projected;
}

function hasConflictingEntitySessionIdentity(
  entity: Record<string, unknown>,
  kiloSessionId: string
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(entity, 'sessionID') && entity.sessionID !== kiloSessionId
  );
}

function hasConflictingMessageEventIdentity(
  properties: Record<string, unknown>,
  kiloSessionId: string
): boolean {
  return (
    isRecord(properties.info) && hasConflictingEntitySessionIdentity(properties.info, kiloSessionId)
  );
}

function hasConflictingPartEventIdentity(
  properties: Record<string, unknown>,
  kiloSessionId: string
): boolean {
  const part = properties.part;
  if (!isRecord(part)) return false;
  if (hasConflictingEntitySessionIdentity(part, kiloSessionId)) return true;
  if (part.type !== 'tool' || !isRecord(part.state) || !Array.isArray(part.state.attachments)) {
    return false;
  }
  return part.state.attachments.some(
    attachment =>
      isRecord(attachment) && hasConflictingEntitySessionIdentity(attachment, kiloSessionId)
  );
}

function projectMessageEventProperties(
  properties: Record<string, unknown>,
  kiloSessionId: string
): Record<string, unknown> | null {
  const info = properties.info;
  if (!isRecord(info)) return hasUnprojectedPrivateStructuredPath(properties) ? null : properties;
  if (info.role !== 'user' && info.role !== 'assistant') {
    return hasUnprojectedPrivateStructuredPath(properties) ? null : properties;
  }
  const projected = { ...properties, info: projectLooseMessageInfo(info, kiloSessionId) };
  return hasUnprojectedPrivateStructuredPath(projected) ? null : projected;
}

function projectPartEventProperties(
  properties: Record<string, unknown>,
  kiloSessionId: string
): Record<string, unknown> | null {
  const part = properties.part;
  if (!isRecord(part) || typeof part.type !== 'string') {
    return hasUnprojectedPrivateStructuredPath(properties) ? null : properties;
  }
  const projected = { ...properties, part: projectLoosePart(part, kiloSessionId) };
  return hasUnprojectedPrivateStructuredPath(projected) ? null : projected;
}

export function projectPublicEvent(
  event: PublicProjectableEvent,
  kiloSessionId: string
): PublicProjectableEvent | null {
  if (event.properties.sessionID !== kiloSessionId) return null;
  let properties: Record<string, unknown> | null;
  switch (event.type) {
    case 'session.updated':
      properties = projectSessionEventProperties(event.properties, kiloSessionId);
      break;
    case 'message.updated':
      properties = hasConflictingMessageEventIdentity(event.properties, kiloSessionId)
        ? null
        : projectMessageEventProperties(event.properties, kiloSessionId);
      break;
    case 'message.part.updated':
      properties = hasConflictingPartEventIdentity(event.properties, kiloSessionId)
        ? null
        : projectPartEventProperties(event.properties, kiloSessionId);
      break;
    default:
      properties = hasUnprojectedPrivateStructuredPath(event.properties) ? null : event.properties;
      break;
  }
  return properties ? { ...event, properties } : null;
}
