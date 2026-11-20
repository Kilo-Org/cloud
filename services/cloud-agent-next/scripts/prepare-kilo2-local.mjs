import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const orgId = process.argv[2];
if (
  !orgId ||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(orgId)
)
  throw new Error('Usage: node scripts/prepare-kilo2-local.mjs <organization-uuid> [--wakeups]');
const config = parse(await fs.readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
config.env.dev.vars.RUNTIME_KILO2_ORG_IDS = orgId;
config.env.dev.vars.RUNTIME_KILO2_ALL_SESSION_ORG_IDS = orgId;
if (process.argv.includes('--wakeups')) config.env.dev.vars.LOCAL_CLOUD_WAKEUPS = '1';
await fs.writeFile(
  path.join(root, 'wrangler.kilo2-local.json'),
  JSON.stringify(config, null, 2) + '\n'
);
console.log(
  "Prepared local downloaded Kilo v2 configuration. Restart this worktree's Cloud Agent Worker."
);
