export function projectPrivateWorktreePaths<T extends object>(
  value: T,
  metadata: readonly unknown[],
  publicDirectory: string
): T {
  const privateDirectories = new Set<string>();
  const addDirectory = (directory: unknown) => {
    if (
      typeof directory === 'string' &&
      /^\/.*\/worktrees\/worktree_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        directory
      )
    ) {
      privateDirectories.add(directory);
    }
  };

  for (const info of metadata) {
    if (typeof info !== 'object' || info === null) continue;
    if ('directory' in info) addDirectory(info.directory);
    if (
      'role' in info &&
      info.role === 'assistant' &&
      'path' in info &&
      typeof info.path === 'object' &&
      info.path !== null
    ) {
      if ('cwd' in info.path) addDirectory(info.path.cwd);
      if ('root' in info.path) addDirectory(info.path.root);
    }
  }

  const project = (target: object) => {
    const entries: [string, unknown][] = Object.entries(target);
    for (const [key, current] of entries) {
      if (typeof current === 'string') {
        let projected = current;
        for (const directory of privateDirectories) {
          projected = projected.replaceAll(directory, publicDirectory);
        }
        Reflect.set(target, key, projected);
      } else if (typeof current === 'object' && current !== null) {
        project(current);
      }
    }
  };

  const projected = structuredClone(value);
  if (privateDirectories.size > 0) project(projected);
  return projected;
}
