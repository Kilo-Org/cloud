const { existsSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const workspace = process.env.GITHUB_WORKSPACE;
if (!workspace) throw new Error('GITHUB_WORKSPACE is required');

const modules = join(workspace, 'node_modules');
if (existsSync(modules)) {
  for (const entry of readdirSync(modules)) {
    if (entry !== '.pnpm-store') rmSync(join(modules, entry), { recursive: true, force: true });
  }
}
