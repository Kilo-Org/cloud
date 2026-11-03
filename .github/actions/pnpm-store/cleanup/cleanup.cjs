const { lstatSync, readdirSync, realpathSync, rmSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');

const warn = message => process.stdout.write(`::warning::${message}\n`);

const reset = () => {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) throw new Error('GITHUB_WORKSPACE is required');
  if (!isAbsolute(workspace)) throw new Error('GITHUB_WORKSPACE must be an absolute path');

  const modules = join(workspace, 'node_modules');
  const modulesStat = lstatSync(modules, { throwIfNoEntry: false });
  if (!modulesStat) return;
  if (modulesStat.isSymbolicLink() || !modulesStat.isDirectory()) {
    warn(`Leaving node_modules untouched: ${modules} is not a real directory inside the checkout.`);
    return;
  }

  // Every path below is canonical, so the reset can only reach entries that
  // really live under the checkout's own node_modules.
  const workspaceReal = realpathSync(workspace);
  const modulesReal = realpathSync(modules);
  if (modulesReal !== join(workspaceReal, 'node_modules')) {
    warn(`Leaving node_modules untouched: ${modules} resolves outside the checkout.`);
    return;
  }

  for (const entry of readdirSync(modulesReal)) {
    if (entry === '.pnpm-store') continue;
    const path = join(modulesReal, entry);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    // rmSync removes a link itself instead of its target, so a linked entry is
    // dropped without reaching past the entry's own path.
    if (!stat.isSymbolicLink() && realpathSync(path) !== path) {
      warn(`Leaving ${path} untouched: it does not resolve to its own path.`);
      continue;
    }
    rmSync(path, { recursive: true, force: true });
  }
};

// Returning instead of calling process.exit keeps the warning annotations that
// this script writes to stdout from being dropped when the stream is a pipe.
reset();
