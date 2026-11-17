import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [orgId, ...options] = process.argv.slice(2);
if (
  !orgId ||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(orgId) ||
  (options.length !== 0 && (options.length !== 2 || options[0] !== '--cli-build' || !options[1]))
)
  throw new Error(
    'Usage: node scripts/prepare-kilo2-local.mjs <organization-uuid> [--cli-build <cli-linux-x64-directory>]'
  );
const cliBuild = options.length === 2 ? path.resolve(options[1]) : undefined;
if (cliBuild !== undefined && !(await fs.stat(cliBuild).catch(() => undefined))?.isDirectory())
  throw new Error('--cli-build must name a CLI platform build directory');
const config = parse(await fs.readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
config.env.dev.vars.RUNTIME_KILO2_ORG_IDS = orgId;
await fs.writeFile(
  path.join(root, 'wrangler.kilo2-local.json'),
  JSON.stringify(config, null, 2) + '\n'
);
const marker = path.join(root, '.wrangler/kilo2-local-cli-build');
if (cliBuild === undefined) await fs.rm(marker, { force: true });
else {
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, `${cliBuild}\n`);
}
console.log(
  `Prepared local downloaded Kilo v2 configuration${
    cliBuild === undefined ? '' : ` with the local CLI build at ${cliBuild}`
  }. Restart this worktree's Cloud Agent Worker.`
);
