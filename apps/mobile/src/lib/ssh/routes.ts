import { type Href } from 'expo-router';

export const SSH_HOSTS_ROUTE = '/(app)/ssh' as Href;
export const SSH_HOST_NEW_ROUTE = '/(app)/ssh/host/new' as Href;
export const SSH_HOST_IMPORT_ROUTE = '/(app)/ssh/import' as Href;
export const SSH_KNOWN_HOSTS_ROUTE = '/(app)/ssh/known-hosts' as Href;
export const SSH_KEY_NEW_ROUTE = '/(app)/ssh/key/new' as Href;
export const SSH_KEY_IMPORT_ROUTE = '/(app)/ssh/key/import' as Href;
export const SSH_SNIPPETS_ROUTE = '/(app)/ssh/snippets' as Href;

export function sshHostPath(hostId: string): Href {
  return `/(app)/ssh/host/${encodeURIComponent(hostId)}` as Href;
}

export function sshSessionPath(sessionId: string): Href {
  return `/(app)/ssh/session/${encodeURIComponent(sessionId)}` as Href;
}

/** The session's remote files, optionally opened at one of its folders. */
export function sshFilesPath(
  sessionId: string,
  options: { path?: string; dev?: string } = {}
): Href {
  const href: Href = {
    pathname: '/(app)/ssh/session/[session-id]/files',
    params: {
      'session-id': sessionId,
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.dev === undefined ? {} : { dev: options.dev }),
    },
  };
  return href;
}

export function sshPromptPath(sessionId: string): Href {
  return `/(app)/ssh/prompt/${encodeURIComponent(sessionId)}` as Href;
}

/** A terminal in a Cloud Agent session's sandbox. */
export function sshSandboxPath(input: {
  cloudAgentSessionId: string;
  organizationId?: string;
  /** The session's title, which the screen shows while it opens. */
  title: string;
}): Href {
  const href: Href = {
    pathname: '/(app)/ssh/sandbox/[session-id]',
    params: {
      'session-id': input.cloudAgentSessionId,
      title: input.title,
      ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
    },
  };
  return href;
}
