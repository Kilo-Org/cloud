import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const loaders = ['launch-document.mjs'];
const modifiedAt = new Date('2000-01-01T00:00:00Z');

/** Only the launch loader and a generated Dockerfile enter this bundle. Never copy a worktree or its environment. */
export function buildAwsRuntimeBundle({ baseImage, output }) {
  const match =
    /^(\d{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com)\/([a-z0-9][a-z0-9._/-]*)@sha256:([a-f0-9]{64})$/.exec(
      baseImage
    );
  if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('AWS runtime base must use a private us-east-1 ECR image pinned by SHA256.');
  }
  const destination = resolve(output);
  const temporary = mkdtempSync(join(tmpdir(), 'kilo-aws-runtime-bundle-'));
  try {
    const dockerfile = [
      `FROM --platform=linux/amd64 ${baseImage}`,
      'USER root',
      'RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && python3 --version',
      // The ECS task definition sets the entrypoint. The image only carries the launch loader.
      'COPY launch-document.mjs /opt/kilo/aws/',
      '',
    ].join('\n');
    const files = ['Dockerfile', ...loaders];
    for (const name of files) {
      const content =
        name === 'Dockerfile'
          ? dockerfile
          : readFileSync(new URL(`./runtime/${name}`, import.meta.url));
      const path = join(temporary, name);
      writeFileSync(path, content, { mode: 0o644, flag: 'wx' });
      chmodSync(path, 0o644);
      utimesSync(path, modifiedAt, modifiedAt);
    }
    const archive = join(temporary, 'runtime.zip');
    execFileSync('zip', ['-X', '-0', '-q', archive, ...files], {
      cwd: temporary,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TZ: 'UTC' },
      stdio: 'pipe',
    });
    const bytes = readFileSync(archive);
    // Refuse replacement or ZIP update. Each release gets its own content-addressed object key.
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { 'base-image': { type: 'string' }, out: { type: 'string' } },
    });
    if (!values['base-image'] || !values.out) throw new Error('Missing input');
    console.log(
      JSON.stringify(buildAwsRuntimeBundle({ baseImage: values['base-image'], output: values.out }))
    );
  } catch {
    // A malformed CLI input or subprocess error can contain secrets. Do not echo it.
    console.error(
      'AWS runtime bundle build failed. Use --base-image <private-ECR-image@sha256:digest> --out <new-file>; zip must be installed.'
    );
    process.exitCode = 1;
  }
}
