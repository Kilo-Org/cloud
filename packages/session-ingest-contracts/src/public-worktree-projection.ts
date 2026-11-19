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

  // The directory set is complete before the walk, so each escaped pattern is
  // compiled once per call instead of once per string property.
  const privatePatterns = [...privateDirectories].map(
    directory => new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  );

  const project = (target: object) => {
    const entries: [string, unknown][] = Object.entries(target);
    for (const [key, current] of entries) {
      if (typeof current === 'string') {
        let projected = current;
        for (const pattern of privatePatterns) {
          projected = projected.replace(pattern, () => publicDirectory);
        }
        Reflect.set(target, key, projected);
      } else if (typeof current === 'object' && current !== null) {
        project(current);
      }
    }
  };

  const projected = structuredClone(value);
  if (privatePatterns.length > 0) project(projected);
  return projected;
}
