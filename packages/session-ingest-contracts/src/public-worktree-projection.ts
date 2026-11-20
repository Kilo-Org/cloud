export function projectKnownCloudAgentPath(
  path: string,
  publicDirectory: string
): string | undefined {
  const root =
    /^\/workspace\/(?:(?:[^/]+\/){1,2}(?:sessions|worktrees)\/(?:ses_|sess_|agent_|workspace_|worktree_)[^/]+|app)(?=\/|$)/.exec(
      path
    )?.[0];
  if (!root || path.split('/').includes('..')) return undefined;
  return publicDirectory + path.slice(root.length);
}

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

  // The directory set is complete before the walk: escape every collected
  // directory once, combine them into one pattern with the longest directory
  // first, and reuse that pattern for the whole walk.
  const orderedDirectories = [...privateDirectories].sort((a, b) => b.length - a.length);
  const privatePattern =
    orderedDirectories.length === 0
      ? undefined
      : new RegExp(
          orderedDirectories
            .map(directory => directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|'),
          'gi'
        );

  const project = (target: object, pattern: RegExp) => {
    const entries: [string, unknown][] = Object.entries(target);
    for (const [key, current] of entries) {
      if (typeof current === 'string') {
        Reflect.set(
          target,
          key,
          current.replace(pattern, () => publicDirectory)
        );
      } else if (typeof current === 'object' && current !== null) {
        project(current, pattern);
      }
    }
  };

  const projected = structuredClone(value);
  if (privatePattern) project(projected, privatePattern);
  return projected;
}
