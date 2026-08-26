const directories = new Map<string, string>();
const rootBySessionId = new Map<string, string>();
const rootByDirectory = new Map<string, string>();

export function rememberSessionDirectory(kiloSessionId: string, directory: string): void {
  directories.set(kiloSessionId, directory);
}

export function rememberAttachedRoot(rootKiloSessionId: string, directory: string): void {
  directories.set(rootKiloSessionId, directory);
  rootBySessionId.set(rootKiloSessionId, rootKiloSessionId);
  rootByDirectory.set(directory, rootKiloSessionId);
}

export function rememberChildSession(input: {
  childId: string;
  parentId?: string;
  directory?: string;
}): void {
  const root =
    (input.parentId ? rootBySessionId.get(input.parentId) : undefined) ??
    (input.directory ? rootByDirectory.get(input.directory) : undefined);
  if (!root) return;
  rootBySessionId.set(input.childId, root);
  if (input.directory) directories.set(input.childId, input.directory);
}

export function rootForSession(
  kiloSessionId: string | undefined,
  directory?: string
): string | undefined {
  if (kiloSessionId) {
    const root = rootBySessionId.get(kiloSessionId);
    if (root) return root;
  }
  return directory ? rootByDirectory.get(directory) : undefined;
}

export function resetSessionDirectoryState(): void {
  directories.clear();
  rootBySessionId.clear();
  rootByDirectory.clear();
}

export function directoryForSession(kiloSessionId: string | undefined): string | undefined {
  return kiloSessionId ? directories.get(kiloSessionId) : undefined;
}
