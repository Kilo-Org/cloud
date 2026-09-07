const directories = new Map<string, string>();
const rootBySessionId = new Map<string, string>();
const rootsByDirectory = new Map<string, Set<string>>();
const detachedSessionIds = new Set<string>();
const rootAttachments = new Map<string, symbol>();

export function rootAttachmentId(rootKiloSessionId: string): symbol | undefined {
  return rootAttachments.get(rootKiloSessionId);
}

function removeDirectoryRoot(directory: string, rootKiloSessionId: string): void {
  const roots = rootsByDirectory.get(directory);
  if (!roots) return;
  roots.delete(rootKiloSessionId);
  if (roots.size === 0) rootsByDirectory.delete(directory);
}

export function rememberSessionDirectory(kiloSessionId: string, directory: string): void {
  directories.set(kiloSessionId, directory);
}

export function rememberAttachedRoot(rootKiloSessionId: string, directory: string): void {
  const previousDirectory = directories.get(rootKiloSessionId);
  if (!rootAttachments.has(rootKiloSessionId) || previousDirectory !== directory) {
    rootAttachments.set(rootKiloSessionId, Symbol());
  }
  if (previousDirectory && previousDirectory !== directory) {
    removeDirectoryRoot(previousDirectory, rootKiloSessionId);
  }
  directories.set(rootKiloSessionId, directory);
  rootBySessionId.set(rootKiloSessionId, rootKiloSessionId);
  detachedSessionIds.delete(rootKiloSessionId);
  const roots = rootsByDirectory.get(directory) ?? new Set<string>();
  roots.add(rootKiloSessionId);
  rootsByDirectory.set(directory, roots);
}

export function forgetAttachedRoot(rootKiloSessionId: string, directory?: string): void {
  const attachedDirectory = directories.get(rootKiloSessionId);
  if (
    directory !== undefined &&
    (rootBySessionId.get(rootKiloSessionId) !== rootKiloSessionId ||
      attachedDirectory !== directory)
  ) {
    return;
  }
  if (attachedDirectory) removeDirectoryRoot(attachedDirectory, rootKiloSessionId);
  rootAttachments.delete(rootKiloSessionId);
  detachedSessionIds.add(rootKiloSessionId);
  for (const [sessionId, root] of rootBySessionId) {
    if (root !== rootKiloSessionId) continue;
    rootBySessionId.delete(sessionId);
    directories.delete(sessionId);
    detachedSessionIds.add(sessionId);
  }
  directories.delete(rootKiloSessionId);
}

export function rememberChildSession(input: {
  childId: string;
  parentId?: string;
  directory?: string;
}): void {
  if (!input.parentId) return;
  if (rootBySessionId.has(input.childId)) return;
  if (detachedSessionIds.has(input.parentId)) {
    detachedSessionIds.add(input.childId);
    return;
  }
  const root = rootForSession(input.parentId);
  if (!root) return;
  const childDirectory =
    input.directory ?? directories.get(input.parentId) ?? directories.get(root);
  const directoryRoots = childDirectory ? rootsByDirectory.get(childDirectory) : undefined;
  if (directoryRoots && !directoryRoots.has(root)) return;
  rootBySessionId.set(input.childId, root);
  detachedSessionIds.delete(input.childId);
  if (childDirectory) directories.set(input.childId, childDirectory);
}

export function rootForSession(
  kiloSessionId: string | undefined,
  directory?: string
): string | undefined {
  if (kiloSessionId !== undefined) {
    const sessionDirectory = directories.get(kiloSessionId);
    if (directory !== undefined && sessionDirectory !== directory) return undefined;
    const root = rootBySessionId.get(kiloSessionId);
    if (!root) return undefined;
    const directoryRoots = sessionDirectory ? rootsByDirectory.get(sessionDirectory) : undefined;
    if (directoryRoots && !directoryRoots.has(root)) return undefined;
    return root;
  }
  const roots = directory ? rootsByDirectory.get(directory) : undefined;
  return roots?.size === 1 ? roots.values().next().value : undefined;
}

export function directoriesForRoot(rootKiloSessionId: string, directory: string): string[] {
  const result = new Set([directories.get(rootKiloSessionId) ?? directory]);
  for (const [sessionId, root] of rootBySessionId) {
    if (root !== rootKiloSessionId) continue;
    const childDirectory = directories.get(sessionId);
    if (childDirectory) result.add(childDirectory);
  }
  return [...result].filter(directory => {
    const roots = rootsByDirectory.get(directory);
    return !roots || roots.has(rootKiloSessionId);
  });
}

export function resetSessionDirectoryState(): void {
  directories.clear();
  rootBySessionId.clear();
  rootsByDirectory.clear();
  detachedSessionIds.clear();
  rootAttachments.clear();
}

export function directoryForSession(kiloSessionId: string | undefined): string | undefined {
  return kiloSessionId ? directories.get(kiloSessionId) : undefined;
}
