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

function privateWorktreeDirectory(message: KiloSdkStoredMessage): string | undefined {
  if (message.info.role !== 'assistant') return undefined;
  return [message.info.path.cwd, message.info.path.root].find(directory =>
    /^\/.*\/worktrees\/worktree_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      directory
    )
  );
}

function projectPrivateWorktreeValue(
  value: unknown,
  privateDirectory: string,
  publicDirectory: string
): unknown {
  if (typeof value === 'string') return value.replaceAll(privateDirectory, publicDirectory);
  if (Array.isArray(value)) {
    return value.map(item => projectPrivateWorktreeValue(item, privateDirectory, publicDirectory));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        projectPrivateWorktreeValue(item, privateDirectory, publicDirectory),
      ])
    );
  }
  return value;
}

function projectPrivateWorktreeMessage(
  message: KiloSdkStoredMessage,
  privateDirectory: string,
  kiloSessionId: string
): KiloSdkStoredMessage {
  const projected = { ...message };
  const publicDirectory = publicCloudAgentDirectory(kiloSessionId);
  for (const [key, value] of Object.entries(message)) {
    Reflect.set(
      projected,
      key,
      projectPrivateWorktreeValue(value, privateDirectory, publicDirectory)
    );
  }
  return projected;
}

export function projectPublicStoredMessage(
  message: KiloSdkStoredMessage,
  kiloSessionId: string
): KiloSdkStoredMessage {
  const privateDirectory = privateWorktreeDirectory(message);
  const sanitized = privateDirectory
    ? projectPrivateWorktreeMessage(message, privateDirectory, kiloSessionId)
    : message;
  return {
    info: projectPublicMessageInfo(sanitized.info, kiloSessionId),
    parts: sanitized.parts.map(part => projectPublicPart(part, kiloSessionId)),
  };
}

export function projectPublicStoredMessages(
  messages: KiloSdkStoredMessage[],
  kiloSessionId: string
): KiloSdkStoredMessage[] {
  return messages.map(message => projectPublicStoredMessage(message, kiloSessionId));
}
