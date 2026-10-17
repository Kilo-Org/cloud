import { shellQuote } from '../kilo/utils.js';
import { CONTROL_PLANE_NATIVE_LOGS_ENV } from '../shared/control-diagnostics.js';
import { CONTROL_SANDBOX_PROVIDER_ENV } from '../shared/sandbox-provider.js';
import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  RUNTIME_DISTRIBUTION,
  RUNTIME_RESERVED_ROOT,
  WRAPPER_BUNDLES,
  runtimeInstallPath,
} from '../shared/runtime-distribution.js';
import type { ProviderStartupCommand } from './provider.js';
import { RUNTIME_ARCHIVE_SCANNER_SOURCE } from './runtime-archive.js';
import {
  parseRuntimeRelease,
  serializeRuntimeRelease,
  RUNTIME_BASE_ABI,
  RUNTIME_BASE_BUN_VERSION,
  RUNTIME_FETCH_ATTEMPTS,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
} from './runtime-release.js';
import { STARTUP_FAILURES } from './startup-failure.js';

const exitCodes = Object.fromEntries(
  Object.entries(STARTUP_FAILURES).map(([code, value]) => [code, value.exitCode])
);
const aliases = [
  ...WRAPPER_BUNDLES.map(bundle => runtimeInstallPath(bundle.installName)),
  runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName),
  GIT_CREDENTIAL_HELPER.realPath,
  GIT_CREDENTIAL_HELPER.linkPath,
];

// Only launch-owned values cross into host tools and the selected runtime.
const inheritedEnv = [
  'SANDBOX_CONTROL_URL',
  'SANDBOX_CONTROL_CREDENTIAL',
  'CONTROL_PLANE_ALLOCATION_ID',
  'PROVIDER_INSTANCE_ID',
  'WRAPPER_LOG_PATH',
  'CONTROL_LOG_UPLOAD_URL',
  'CONTROL_LOG_UPLOAD_GRANT',
  'CONTROL_WRAPPER_INSTANCE_ID',
  'CONTROL_WORKLOAD_CGROUP',
  'CONTROL_WORKLOAD_LIMIT_MB',
  CONTROL_PLANE_NATIVE_LOGS_ENV,
  'SANDBOX_INTERCEPT_HTTPS',
  'NODE_EXTRA_CA_CERTS',
  CONTROL_SANDBOX_PROVIDER_ENV,
  'KILO_PLATFORM',
  'KILO_DISABLE_AUTOUPDATE',
  'KILO_DEBUG_SESSION_INGEST',
];

const INSTALLER = String.raw`
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const C = JSON.parse(process.env.KILO_RUNTIME_BOOTSTRAP);
const EXIT = C.exitCodes;
class Failure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new Failure(code); }
function deadline() { if (Date.now() >= C.deadlineAt) fail('deadline_exceeded'); }
function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function realDirectory(directory) {
  let current = '/';
  for (const part of path.resolve(directory).split('/').filter(Boolean)) {
    current = path.join(current, part);
    let entry = stat(current);
    if (entry === null) {
      try { fs.mkdirSync(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      entry = stat(current);
    }
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) fail('artifact_invalid');
  }
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function safePath(base, relative) {
  if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('artifact_invalid');
  return path.join(base, relative);
}
function atomicLink(target, link) {
  const old = stat(link);
  if (old && old.isDirectory()) fail('artifact_invalid');
  const temporary = link + '.tmp-' + randomUUID();
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, link);
}
function prepare() {
  deadline();
  realDirectory(C.root);
  for (const directory of ['archives', 'cli', 'control', 'releases']) realDirectory(path.join(C.root, directory));
  const lock = stat(path.join(C.root, '.setup.lock'));
  if (lock && (!lock.isFile() || lock.isSymbolicLink())) fail('artifact_invalid');
}
function compatible() {
  const d = C.descriptor;
  const bun = spawnSync('/usr/local/bin/bun', ['--version'], { encoding: 'utf8', timeout: Math.max(1, C.deadlineAt - Date.now()) });
  deadline();
  let libc;
  try { libc = process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'; }
  catch { fail('base_incompatible'); }
  if (d.abi !== C.baseAbi || process.platform !== d.platform.os || process.arch !== d.platform.arch || libc !== d.platform.libc || process.versions.node.split('.')[0] !== C.nodeMajor || bun.status !== 0 || bun.stdout.trim() !== C.bun) fail('base_incompatible');
  if (d.platform.cpu === 'modern' && !/(^|\s)avx2(\s|$)/.test(fs.readFileSync('/proc/cpuinfo', 'utf8').replace(/:/g, ' '))) fail('base_incompatible');
}
async function download(artifact) {
  for (let attempt = 0; attempt < C.fetchAttempts; attempt++) {
    deadline();
    try {
      const response = await fetch(C.artifactBaseUrl + artifact.sha256, {
        headers: { Authorization: 'Bearer ' + C.grant }, redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, C.deadlineAt - Date.now())),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel(); fail('artifact_unauthorized');
      }
      if (!response.ok) { await response.body?.cancel(); continue; }
      if (!response.body) fail('artifact_invalid');
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        for (;;) {
          deadline();
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > artifact.transferBytes) fail('artifact_invalid');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = Buffer.concat(chunks, length);
      if (length !== artifact.transferBytes || hash(bytes) !== artifact.sha256) fail('artifact_invalid');
      return bytes;
    } catch (error) {
      if (error instanceof Failure) throw error;
      deadline();
    }
  }
  fail('artifact_unavailable');
}
async function archive(artifact) {
  const file = path.join(C.root, 'archives', artifact.sha256 + '.tar.zst');
  const existing = stat(file);
  if (existing && existing.isFile() && !existing.isSymbolicLink() && existing.size === artifact.transferBytes) {
    const bytes = fs.readFileSync(file);
    if (hash(bytes) === artifact.sha256) return bytes;
  }
  if (existing) {
    if (existing.isDirectory()) fail('artifact_invalid');
    fs.unlinkSync(file);
  }
  const bytes = await download(artifact);
  const temporary = file + '.tmp-' + randomUUID();
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  const keep = new Set(C.descriptor.artifacts.map(value => value.sha256 + '.tar.zst'));
  try {
    const current = JSON.parse(fs.readFileSync(path.join(C.root, 'active', 'descriptor.json'), 'utf8'));
    for (const value of current.artifacts) keep.add(value.sha256 + '.tar.zst');
  } catch {}
  for (const name of fs.readdirSync(path.join(C.root, 'archives'))) {
    if (/^[a-f0-9]{64}\.tar\.zst$/.test(name) && !keep.has(name)) fs.unlinkSync(path.join(C.root, 'archives', name));
  }
  return bytes;
}
async function extract(artifact) {
  const bytes = await archive(artifact);
  deadline();
  let scan;
  try {
    const overhead = artifact.fileCount * 8192 + 1024 * 1024;
    const tar = zlib.zstdDecompressSync(bytes, { maxOutputLength: Math.min(C.descriptor.caps.maxExpandedBytes + overhead, C.maxExpandedBytes) });
    scan = scanRuntimeArchive(tar);
  } catch { fail('artifact_invalid'); }
  if (scan.fileCount !== artifact.fileCount || scan.expandedBytes !== artifact.expandedBytes) fail('artifact_invalid');
  const namespace = path.join(C.root, artifact.role, artifact.sha256);
  realDirectory(namespace);
  const staging = fs.mkdtempSync(path.join(namespace, '.staging-'));
  for (const file of scan.files) {
    deadline();
    const target = safePath(staging, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes, { flag: 'wx', mode: file.mode & 0o777 });
  }
  const target = path.join(namespace, randomUUID());
  fs.renameSync(staging, target);
  return target;
}
function previousRelease() {
  const active = path.join(C.root, 'active');
  const entry = stat(active);
  if (!entry) return null;
  if (!entry.isSymbolicLink()) fail('artifact_invalid');
  const target = path.resolve(C.root, fs.readlinkSync(active));
  if (!target.startsWith(path.join(C.root, 'releases') + '/')) fail('artifact_invalid');
  return target;
}
function collect(keep) {
  // The shell holds the allocation's flock through supervisor exec. No other
  // live runtime can be using these directories while setup holds this lock.
  const referenced = new Set();
  const archives = new Set(C.descriptor.artifacts.map(value => value.sha256 + '.tar.zst'));
  for (const release of keep) {
    for (const role of ['cli', 'control']) {
      try {
        const target = fs.realpathSync(path.join(release, role));
        referenced.add(target);
        archives.add(path.basename(path.dirname(target)) + '.tar.zst');
      } catch {}
    }
  }
  for (const role of ['cli', 'control']) {
    const root = path.join(C.root, role);
    for (const digest of fs.readdirSync(root)) {
      if (!/^[a-f0-9]{64}$/.test(digest)) continue;
      const namespace = path.join(root, digest);
      const entry = stat(namespace);
      if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      for (const name of fs.readdirSync(namespace)) {
        const directory = path.join(namespace, name);
        if (!referenced.has(directory)) fs.rmSync(directory, { recursive: true, force: true });
      }
      if (fs.readdirSync(namespace).length === 0) fs.rmdirSync(namespace);
    }
  }
  const releases = path.join(C.root, 'releases');
  for (const name of fs.readdirSync(releases)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const namespace = path.join(releases, name);
    const entry = stat(namespace);
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    for (const generation of fs.readdirSync(namespace)) {
      const directory = path.join(namespace, generation);
      if (!keep.includes(directory)) fs.rmSync(directory, { recursive: true, force: true });
    }
    if (fs.readdirSync(namespace).length === 0) fs.rmdirSync(namespace);
  }
  const cache = path.join(C.root, 'archives');
  for (const name of fs.readdirSync(cache)) {
    if ((/^[a-f0-9]{64}\.tar\.zst$/.test(name) && !archives.has(name)) || /^[a-f0-9]{64}\.tar\.zst\.tmp-[a-f0-9-]+$/.test(name)) fs.unlinkSync(path.join(cache, name));
  }
}
async function install() {
  prepare(); compatible();
  const previous = previousRelease();
  collect(previous ? [previous] : []);
  const cliArtifact = C.descriptor.artifacts.find(artifact => artifact.role === 'cli');
  const controlArtifact = C.descriptor.artifacts.find(artifact => artifact.role === 'control');
  const cli = await extract(cliArtifact);
  const control = await extract(controlArtifact);
  deadline();
  const releaseId = hash(JSON.stringify(C.descriptor));
  const namespace = path.join(C.root, 'releases', releaseId);
  realDirectory(namespace);
  const staging = fs.mkdtempSync(path.join(namespace, '.staging-'));
  fs.writeFileSync(path.join(staging, 'descriptor.json'), JSON.stringify(C.descriptor), { flag: 'wx' });
  fs.symlinkSync(cli, path.join(staging, 'cli'));
  fs.symlinkSync(control, path.join(staging, 'control'));
  const release = path.join(namespace, randomUUID());
  fs.renameSync(staging, release);
  // Every alias resolves through active, including during the first install.
  atomicLink(release, path.join(C.root, 'active'));
  for (const alias of C.aliases) {
    realDirectory(path.dirname(alias));
    const relative = alias === C.credentialHelperLink ? C.credentialHelper.slice(1) : alias.slice(1);
    atomicLink(path.join(C.root, 'active', 'control', relative), alias);
  }
  collect(previous ? [release, previous] : [release]);
  process.stdout.write(safePath(cli, C.descriptor.cliExecutable));
}
try {
  if (process.argv.at(-1) === 'preflight') prepare();
  else await install();
} catch (error) {
  process.exit(error instanceof Failure ? EXIT[error.code] : EXIT.install_interrupted);
}
`;

const PROBE = String.raw`
import { spawnSync } from 'node:child_process';
const [cli, version, until] = process.argv.slice(1);
const deadline = Number(until);
if (Date.now() >= deadline) process.exit(${STARTUP_FAILURES.deadline_exceeded.exitCode});
try {
  const result = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 65536, killSignal: 'SIGKILL' });
  if (Date.now() >= deadline) process.exit(${STARTUP_FAILURES.deadline_exceeded.exitCode});
  if (result.status !== 0 || result.stdout.trim() !== version) process.exit(${STARTUP_FAILURES.cli_probe_failed.exitCode});
} catch { process.exit(${STARTUP_FAILURES.cli_probe_failed.exitCode}); }
`;

const REPORT = String.raw`
const [url, allocationId, exit] = process.argv.slice(1);
const codes = JSON.parse(process.argv.at(-1));
const code = Object.keys(codes).find(name => codes[name] === Number(exit)) || 'install_interrupted';
try {
  const response = await fetch(url, { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.SANDBOX_CONTROL_CREDENTIAL },
    body: JSON.stringify({ allocationId, code }),
  });
  await response.body?.cancel();
} catch {}
`;

export function renderRuntimeBootstrap(input: {
  descriptor: string;
  artifactBaseUrl: string;
  reportUrl: string;
  allocationId: string;
  grant: string;
  deadlineAt: number;
}): ProviderStartupCommand {
  const descriptor = parseRuntimeRelease(input.descriptor);
  serializeRuntimeRelease(descriptor);
  const artifactUrl = new URL(input.artifactBaseUrl);
  const reportUrl = new URL(input.reportUrl);
  if (
    !['http:', 'https:'].includes(artifactUrl.protocol) ||
    artifactUrl.origin !== reportUrl.origin ||
    artifactUrl.username ||
    artifactUrl.password ||
    artifactUrl.search ||
    artifactUrl.hash ||
    reportUrl.username ||
    reportUrl.password ||
    reportUrl.search ||
    reportUrl.hash
  )
    throw new Error('Invalid runtime startup URLs');
  if (!Number.isSafeInteger(input.deadlineAt)) throw new Error('Invalid runtime deadline');
  const config = JSON.stringify({
    ...input,
    descriptor,
    root: RUNTIME_RESERVED_ROOT,
    aliases,
    exitCodes,
    nodeMajor: RUNTIME_DISTRIBUTION.nodeMajor,
    bun: RUNTIME_BASE_BUN_VERSION,
    baseAbi: RUNTIME_BASE_ABI,
    fetchAttempts: RUNTIME_FETCH_ATTEMPTS,
    maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
    credentialHelper: GIT_CREDENTIAL_HELPER.realPath,
    credentialHelperLink: GIT_CREDENTIAL_HELPER.linkPath,
  });
  const environment = [
    '/usr/bin/env',
    '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/root',
    'LANG=en_US.UTF-8',
    'LC_ALL=en_US.UTF-8',
    ...inheritedEnv.map(name => `${name}="\${${name}:-}"`),
  ].join(' ');
  const installer = shellQuote(`${RUNTIME_ARCHIVE_SCANNER_SOURCE}\n${INSTALLER}`);
  const node = `${environment} /usr/local/bin/node --input-type=module -e`;
  const installNode = `${environment} KILO_RUNTIME_BOOTSTRAP="$bootstrap_config" /usr/local/bin/node --input-type=module -e ${installer}`;
  const script = [
    'set -eu',
    'umask 022',
    `bootstrap_config=${shellQuote(config)}`,
    'startup_exit() {',
    '  startup_rc=$?',
    '  trap - 0',
    '  unset bootstrap_config',
    `  if [ "$startup_rc" -ne 0 ]; then ${node} ${shellQuote(REPORT)} ${shellQuote(input.reportUrl)} ${shellQuote(input.allocationId)} "$startup_rc" ${shellQuote(JSON.stringify(exitCodes))} >/dev/null 2>&1 || :; fi`,
    '  exit "$startup_rc"',
    '}',
    'trap startup_exit 0',
    `${installNode} preflight`,
    `exec 9>${shellQuote(`${RUNTIME_RESERVED_ROOT}/.setup.lock`)}`,
    `/usr/bin/flock -n -E ${STARTUP_FAILURES.install_interrupted.exitCode} 9`,
    `cli_path=$(${installNode} install)`,
    'unset bootstrap_config',
    `if [ ! -f ${shellQuote(runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName))} ]; then exit ${STARTUP_FAILURES.supervisor_missing.exitCode}; fi`,
    `${node} ${shellQuote(PROBE)} "$cli_path" ${shellQuote(descriptor.cliVersion)} ${shellQuote(String(input.deadlineAt))}`,
    'trap - 0',
    `exec ${environment} KILO_RUNTIME_CLI_PATH="$cli_path" /bin/sh ${shellQuote(runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName))}`,
  ].join('\n');
  return { argv: ['/bin/sh', '-c', script] };
}
