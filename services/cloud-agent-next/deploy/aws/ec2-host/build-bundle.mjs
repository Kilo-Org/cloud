import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const host = new URL('./', import.meta.url);
const entry = fileURLToPath(new URL('../../../../sandbox-egress/src/ec2-host.ts', host));
const files = [
  'attach-workspace',
  'detach-workspace',
  'daemon.json',
  'dnsmasq.conf',
  'workload.nft',
  'kilo-ec2.service',
];

async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export function savedDockerImageId(archive) {
  const readEntry = name => execFileSync('tar', ['-xOf', archive, name]);
  const manifest = JSON.parse(readEntry('manifest.json'));
  if (!Array.isArray(manifest) || manifest.length !== 1)
    throw new Error('Expected one EC2 workload image in the archive');
  const configPath = manifest[0]?.Config;
  const digest = /^(?:blobs\/sha256\/([a-f0-9]{64})|([a-f0-9]{64})\.json)$/.exec(configPath ?? '');
  if (!digest) throw new Error('Invalid EC2 workload image configuration path');
  const configBytes = readEntry(configPath);
  const imageId = createHash('sha256').update(configBytes).digest('hex');
  const config = JSON.parse(configBytes);
  if (
    imageId !== (digest[1] ?? digest[2]) ||
    config.os !== 'linux' ||
    config.architecture !== 'amd64'
  )
    throw new Error('Invalid EC2 workload image configuration');
  // The host uses Docker's classic image store, which identifies images by config digest.
  return `sha256:${imageId}`;
}

async function build({ image, output }) {
  const destination = resolve(output);
  const temporary = await mkdtemp(join(tmpdir(), 'kilo-ec2-host-'));
  const archive = `${destination}.partial-${process.pid}`;
  const run = (program, args) =>
    execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  try {
    const [id, operatingSystem, architecture] = run('docker', [
      'image',
      'inspect',
      '--format',
      '{{.Id}} {{.Os}} {{.Architecture}}',
      '--',
      image,
    ]).split(' ');
    if (
      !/^sha256:[a-f0-9]{64}$/.test(id) ||
      operatingSystem !== 'linux' ||
      architecture !== 'amd64'
    )
      throw new Error('Invalid EC2 workload image');
    run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--pull',
      'never',
      '--platform',
      'linux/amd64',
      '--entrypoint',
      '/usr/local/bin/node',
      id,
      '--input-type=module',
      '-e',
      'import {startLaunchFromStdin} from "/opt/kilo/aws/launch-document.mjs"; if (typeof startLaunchFromStdin !== "function") process.exit(1)',
    ]);
    await Promise.all(files.map(name => copyFile(new URL(name, host), join(temporary, name))));
    run('bun', ['build', entry, '--target=node', '--outfile=' + join(temporary, 'host.mjs')]);
    const imageArchive = join(temporary, 'image.tar');
    run('docker', ['image', 'save', '--output', imageArchive, id]);
    const imageId = savedDockerImageId(imageArchive);
    await writeFile(join(temporary, 'image-id'), `${imageId}\n`);
    const content = [...files, 'host.mjs', 'image-id', 'image.tar'];
    const manifest = await Promise.all(
      content.map(async name => `${await hash(join(temporary, name))}  ${name}`)
    );
    await writeFile(join(temporary, 'manifest.sha256'), `${manifest.join('\n')}\n`);
    run('tar', ['-C', temporary, '-czf', archive, ...content, 'manifest.sha256']);
    await link(archive, destination);
    console.log(JSON.stringify({ sha256: await hash(destination), imageId }));
  } finally {
    await rm(archive, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { image: { type: 'string' }, out: { type: 'string' } },
    });
    if (!values.image || !values.out) throw new Error('Missing arguments');
    await build({ image: values.image, output: values.out });
  } catch {
    console.error(
      'EC2 host bundle failed. Use --image <local-linux-amd64-image> --out <new-file>.'
    );
    process.exitCode = 1;
  }
}
