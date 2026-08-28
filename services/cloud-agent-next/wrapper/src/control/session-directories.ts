const directories = new Map<string, string>();
const rootBySessionId = new Map<string, string>();
const rootsByDirectory = new Map<string, Set<string>>();

export function rememberSessionDirectory(kiloSessionId: string, directory: string): void {
  directories.set(kiloSessionId, directory);
}

export function rememberAttachedRoot(rootKiloSessionId: string, directory: string): void {
  directories.set(rootKiloSessionId, directory);
  rootBySessionId.set(rootKiloSessionId, rootKiloSessionId);
  const roots = rootsByDirectory.get(directory) ?? new Set<string>();
  roots.add(rootKiloSessionId);
  rootsByDirectory.set(directory, roots);
}

export function forgetAttachedRoot(rootKiloSessionId: string, directory: string): void {
  if (
    rootBySessionId.get(rootKiloSessionId) !== rootKiloSessionId ||
    directories.get(rootKiloSessionId) !== directory
  ) {
    return;
  }

  for (const [kiloSessionId, root] of rootBySessionId) {
    if (root !== rootKiloSessionId) continue;
    rootBySessionId.delete(kiloSessionId);
    directories.delete(kiloSessionId);
  }

  const roots = rootsByDirectory.get(directory);
  roots?.delete(rootKiloSessionId);
  if (roots?.size === 0) rootsByDirectory.delete(directory);
}

export function rememberChildSession(input: {
  childId: string;
  parentId?: string;
  directory?: string;
}): void {
  if (!input.parentId) return;
  const root = rootBySessionId.get(input.parentId);
  if (!root) return;
  const existing = rootBySessionId.get(input.childId);
  if (existing && existing !== root) return;
  rootBySessionId.set(input.childId, root);
  const directory = input.directory ?? directories.get(input.parentId) ?? directories.get(root);
  if (directory) directories.set(input.childId, directory);
}

export function rootForSession(
  kiloSessionId: string | undefined,
  directory?: string
): string | undefined {
  if (kiloSessionId) return rootBySessionId.get(kiloSessionId);
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
  return [...result];
}

export function resetSessionDirectoryState(): void {
  directories.clear();
  rootBySessionId.clear();
  rootsByDirectory.clear();
}

export function directoryForSession(kiloSessionId: string | undefined): string | undefined {
  return kiloSessionId ? directories.get(kiloSessionId) : undefined;
}
