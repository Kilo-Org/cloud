import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values } = parseArgs({
  options: { 'base-image': { type: 'string' }, output: { type: 'string' } },
});
const image = values['base-image'];
if (
  !image ||
  !/^\d{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/.test(image) ||
  !values.output
)
  throw new Error(
    'Usage: prepare-aws-runtime.ts --base-image <ECR image digest> --output <new zip path>'
  );
const output = resolve(values.output);
if (existsSync(output)) throw new Error('The AWS runtime output path already exists');
const directory = mkdtempSync(join(tmpdir(), 'kilo-aws-runtime-'));
try {
  const files = ['Dockerfile', 'hook.mjs', 'launch-document.mjs'];
  writeFileSync(
    join(directory, 'Dockerfile'),
    `FROM ${image}\nCOPY hook.mjs launch-document.mjs /opt/kilo/aws/\nENTRYPOINT ["/usr/local/bin/node", "/opt/kilo/aws/hook.mjs"]\n`,
    { mode: 0o644 }
  );
  for (const name of files.slice(1))
    writeFileSync(
      join(directory, name),
      readFileSync(new URL(`../deploy/aws/runtime/${name}`, import.meta.url)),
      { mode: 0o644 }
    );
  for (const name of files) utimesSync(join(directory, name), 946684800, 946684800);
  // zip refuses an invalid output directory. The caller chooses a new artifact path.
  execFileSync('zip', ['-X', '-q', output, ...files], {
    cwd: directory,
    env: { ...process.env, TZ: 'UTC' },
    stdio: 'pipe',
  });
  console.log(
    JSON.stringify({
      path: output,
      sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
    })
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
