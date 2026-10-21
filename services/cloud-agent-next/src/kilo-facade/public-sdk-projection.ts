import { projectPrivateWorktreePaths } from '@kilocode/session-ingest-contracts';
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
  const directory = publicCloudAgentDirectory(kiloSessionId);
  if (path === directory || path.startsWith(`${directory}/`)) return path;
  return isAbsoluteStructuredPath(path) ? directory : path;
}

export function projectPublicStructuredPaths<T extends object>(value: T, kiloSessionId: string): T {
  const directory = publicCloudAgentDirectory(kiloSessionId);
  const metadata: Record<string, unknown>[] = [];
  const privateDirectories = new Set<string>();
  function collect(target: unknown): void {
    if (typeof target !== 'object' || target === null) return;
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(target));
    if ('directory' in record || record.role === 'assistant') metadata.push(record);
    const paths = [record.directory];
    if (record.role === 'assistant' && typeof record.path === 'object' && record.path !== null) {
      if ('cwd' in record.path) paths.push(record.path.cwd);
      if ('root' in record.path) paths.push(record.path.root);
    }
    for (const path of paths) {
      if (typeof path === 'string' && path !== '/' && isAbsoluteStructuredPath(path)) {
        privateDirectories.add(path.replace(/[\\/]+$/, ''));
      }
    }
    for (const item of Object.values(record)) collect(item);
  }
  collect(value);
  const roots = [...privateDirectories].sort((a, b) => b.length - a.length);
  function projectPath(path: string): string {
    if (path === directory || path.startsWith(`${directory}/`)) return path;
    for (const root of roots) {
      if (path === root || path.startsWith(`${root}/`)) {
        const projected = projectPrivateWorktreePaths({ path }, metadata, directory).path;
        return projected !== path ? projected : directory + path.slice(root.length);
      }
    }
    return publicPath(path, kiloSessionId);
  }
  function projectDiffPath(path: string): string {
    if (path === '/dev/null') return path;
    if (path.startsWith('"') && path.endsWith('"')) {
      return `"${projectDiffPath(path.slice(1, -1))}"`;
    }
    const prefix = /^(?:a|b)\//.exec(path)?.[0] ?? '';
    return prefix + projectPath(path.slice(prefix.length));
  }
  function projectDiff(diff: string): string {
    let inHunk = false;
    return diff
      .split('\n')
      .map(line => {
        if (/^(?:diff --git |Index: )/.test(line)) inHunk = false;
        if (line.startsWith('@@')) inHunk = true;
        if (inHunk) return line;
        return line
          .replace(
            /^(diff --git )("[^"]*"|\S+) ("[^"]*"|\S+)(\r?)$/,
            (_match, prefix: string, before: string, after: string, ending: string) =>
              `${prefix}${projectDiffPath(before)} ${projectDiffPath(after)}${ending}`
          )
          .replace(
            /^(Index: |--- |\+\+\+ |rename from |rename to |copy from |copy to )("[^"]*"|[^\t\r]+)((?:\t[^\r]*)?\r?)$/,
            (_match, prefix: string, path: string, suffix: string) =>
              prefix + projectDiffPath(path) + suffix
          );
      })
      .join('\n');
  }
  const pathKeys = new Set([
    'path',
    'cwd',
    'root',
    'directory',
    'worktree',
    'filepath',
    'filePath',
    'file',
    'files',
    'visibleFiles',
    'openTabs',
    'activeFile',
    'pattern',
    'patterns',
    'always',
  ]);
  function project(target: object): void {
    const entries: [string, unknown][] = Object.entries(target);
    for (const [key, item] of entries) {
      if (typeof item === 'string' && (key === 'uri' || key === 'url')) {
        Reflect.set(target, key, publicFilePartUrl(item));
      } else if (typeof item === 'string' && pathKeys.has(key))
        Reflect.set(target, key, projectPath(item));
      else if (typeof item === 'string' && (key === 'diff' || key === 'patch')) {
        Reflect.set(target, key, projectDiff(item));
      } else if (Array.isArray(item) && pathKeys.has(key)) {
        Reflect.set(
          target,
          key,
          item.map((path: unknown) => {
            if (typeof path === 'string') return projectPath(path);
            if (typeof path === 'object' && path !== null) project(path);
            return path;
          })
        );
      } else if (typeof item === 'object' && item !== null) project(item);
    }
  }
  const projected = structuredClone(value);
  project(projected);
  return projected;
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
  const projected = projectPublicStructuredPaths(message, kiloSessionId);
  return projected.role === 'assistant'
    ? projectPublicAssistantMessage(projected, kiloSessionId)
    : projectPublicUserMessage(projected, kiloSessionId);
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
  const projected = projectPublicStructuredPaths(part, kiloSessionId);
  if (projected.type === 'file') return projectPublicFilePart(projected, kiloSessionId);
  if (projected.type === 'tool') {
    return { ...projected, state: projectPublicToolState(projected.state, kiloSessionId) };
  }
  if (projected.type === 'patch') {
    return { ...projected, files: projected.files.map(file => publicPath(file, kiloSessionId)) };
  }
  return projected;
}

export function projectPublicStoredMessage(
  message: KiloSdkStoredMessage,
  kiloSessionId: string
): KiloSdkStoredMessage {
  const sanitized = projectPublicStructuredPaths(message, kiloSessionId);
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
