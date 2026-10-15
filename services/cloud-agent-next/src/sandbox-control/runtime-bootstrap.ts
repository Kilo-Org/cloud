import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  RUNTIME_ACTIVE_POINTER,
  RUNTIME_ALIAS_DIR,
  RUNTIME_CLI_ROOT,
  RUNTIME_CONTROL_ROOT,
  RUNTIME_RELEASES_ROOT,
  RUNTIME_RESERVED_ROOT,
} from '../shared/runtime-distribution.js';
import {
  RUNTIME_ARTIFACT_HTTP_PREFIX,
  RUNTIME_BASE_ABI,
  RUNTIME_BASE_BUN_VERSION,
  RUNTIME_BOOTSTRAP_CONTRACT,
  RUNTIME_DEFAULT_DEADLINE_MS,
  RUNTIME_FETCH_ATTEMPTS,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  RUNTIME_MAX_DEADLINE_MS,
  RUNTIME_RELEASE_FORMAT,
  SHA256_PATTERN,
  parseRuntimeRelease,
} from '../shared/runtime-release.js';
import type { RuntimePlatform, RuntimeReleaseDescriptor } from '../shared/runtime-release.js';
import { RUNTIME_ARCHIVE_SCANNER_SOURCE } from '../shared/runtime-archive.js';
import {
  RUNTIME_INSTALLER_EXIT,
  RUNTIME_LAUNCH_ID_PATTERN,
  RUNTIME_LAUNCH_RECEIPT_DIR_NAME,
} from './runtime-launch-receipt.js';

/**
 * Launch-side bootstrap contract (plan §8 "Bootstrap").
 *
 * This module owns the fixed installer text, the serialized launch command, the
 * environment names the command reads, and the constants/caps/schema values the
 * installer validates against. It is free of Node filesystem imports so the Worker
 * can import it: the described paths are text, and the Bun installer that executes
 * inside the sandbox is the string below.
 *
 * The serialized command is `/bin/sh -c '<installer>'`, and the installer shell
 * finishes with `exec /bin/sh <known supervisor path>` so PID 1 keeps the
 * supervisor identity. No restored module is executed: the installer text travels
 * in the launch command, not in the snapshot.
 */

export const RUNTIME_DESCRIPTOR_ENV = 'KILO_RUNTIME_DESCRIPTOR';
export const RUNTIME_ARTIFACT_GRANT_ENV = 'KILO_RUNTIME_ARTIFACT_GRANT';
export const RUNTIME_ARTIFACT_ORIGIN_ENV = 'KILO_RUNTIME_ARTIFACT_ORIGIN';
export const RUNTIME_DEADLINE_MS_ENV = 'KILO_RUNTIME_DEADLINE_MS';
/**
 * Absolute epoch-ms creation deadline carried from the launch options. The shell
 * sets it explicitly from the options, so a profile or user value is never read.
 */
export const RUNTIME_DEADLINE_AT_ENV = 'KILO_RUNTIME_DEADLINE_AT';
/** Optional override for the alias directory; production uses `/usr/local/bin`. */
export const RUNTIME_ALIAS_DIR_ENV = 'KILO_RUNTIME_ALIAS_DIR';
/** Optional override for the reserved root; the process harness sets it. */
export const RUNTIME_RESERVED_ROOT_ENV = 'KILO_RUNTIME_RESERVED_ROOT';
/** Explicit opt-in for a plain-HTTP origin. Only a local fixture sets this. */
export const RUNTIME_ALLOW_INSECURE_ORIGIN_ENV = 'KILO_RUNTIME_ALLOW_INSECURE_ORIGIN';
/** Absolute selected-CLI path exported to the supervisor for future wiring. */
export const RUNTIME_CLI_PATH_ENV = 'KILO_RUNTIME_CLI_PATH';

/**
 * Worker-side contract validation: no filesystem, no download. Used before a
 * release is embedded and by publish tooling. The sandbox Bun installer repeats
 * the same checks against the real host.
 */
export function validateRuntimeReleaseForHost(
  descriptor: RuntimeReleaseDescriptor | string,
  host: RuntimePlatform
): string[] {
  const release = typeof descriptor === 'string' ? parseRuntimeRelease(descriptor) : descriptor;
  const errors: string[] = [];
  if (host.os !== release.platform.os) errors.push('os mismatch');
  if (host.arch !== release.platform.arch) errors.push('arch mismatch');
  if (host.libc !== release.platform.libc) errors.push('libc mismatch');
  if (host.cpu !== 'modern' && release.platform.cpu === 'modern') {
    errors.push('cpu tier mismatch');
  }
  if (release.abi !== RUNTIME_BASE_ABI) errors.push('abi mismatch');
  return errors;
}

const RUNTIME_INSTALLER_HEADER = [
  "import { createHash } from 'node:crypto';",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import zlib from 'node:zlib';",
].join('\n');

/**
 * Single-owner contract rendered into the installer: platform paths, the shared
 * HTTP prefix, hard caps, the required base ABI, the descriptor format, and the
 * executable-inventory rule. The installer validates against these values.
 */
const RUNTIME_INSTALLER_CONTRACT = `const CONTRACT = ${JSON.stringify({
  format: RUNTIME_RELEASE_FORMAT,
  bootstrap: RUNTIME_BOOTSTRAP_CONTRACT,
  roles: ['cli', 'control'],
  shaPattern: SHA256_PATTERN.source,
  httpPrefix: RUNTIME_ARTIFACT_HTTP_PREFIX,
  baseAbi: RUNTIME_BASE_ABI,
  baseBunVersion: RUNTIME_BASE_BUN_VERSION,
  reserved: RUNTIME_RESERVED_ROOT,
  alias: RUNTIME_ALIAS_DIR,
  cli: RUNTIME_CLI_ROOT,
  control: RUNTIME_CONTROL_ROOT,
  releases: RUNTIME_RELEASES_ROOT,
  active: RUNTIME_ACTIVE_POINTER,
  supervisor: CONTROL_PLANE_SUPERVISOR.installName,
  credentialHelperRealPath: GIT_CREDENTIAL_HELPER.realPath,
  hardCaps: {
    maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
    maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
    maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
  },
  defaultDeadlineMs: RUNTIME_DEFAULT_DEADLINE_MS,
  maxDeadlineMs: RUNTIME_MAX_DEADLINE_MS,
  attempts: RUNTIME_FETCH_ATTEMPTS,
})};
const EXIT = ${JSON.stringify(RUNTIME_INSTALLER_EXIT)};`;

const RUNTIME_INSTALLER_BODY = String.raw`
const C = CONTRACT;
const RESERVED_ROOT = envValue('KILO_RUNTIME_RESERVED_ROOT', C.reserved);
const ALIAS_DIR = envValue('KILO_RUNTIME_ALIAS_DIR', C.alias);
const CLI_ROOT = envValue('KILO_RUNTIME_CLI_ROOT', C.cli);
const CONTROL_ROOT = envValue('KILO_RUNTIME_CONTROL_ROOT', C.control);
const RELEASES_ROOT = envValue('KILO_RUNTIME_RELEASES_ROOT', C.releases);
const ACTIVE_POINTER = envValue('KILO_RUNTIME_ACTIVE_POINTER', C.active);
const SHA_RE = new RegExp(C.shaPattern);

function envValue(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

class Fail extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new Fail(code, message);
}

let deadlineAt = 0;
function checkDeadline() {
  if (Date.now() > deadlineAt) fail(EXIT.deadlineExceeded, 'installer deadline exceeded');
}
function remaining() {
  return Math.max(1, deadlineAt - Date.now());
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(target, root) {
  const resolved = path.resolve(target);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function lstatSafe(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// Create and verify a real directory chain, rejecting any symlink component so a
// restored symlink cannot redirect a write.
function assertRealDirChain(directory) {
  const parts = path.resolve(directory).split(path.sep).filter(Boolean);
  let current = path.sep;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstatSafe(current);
    if (stat === null) {
      fs.mkdirSync(current);
      continue;
    }
    if (stat.isSymbolicLink()) fail(EXIT.artifactInvalid, 'unexpected symlink in reserved path: ' + current);
    if (!stat.isDirectory()) fail(EXIT.artifactInvalid, 'unexpected non-directory in reserved path: ' + current);
  }
}

function safeJoin(base, relative) {
  if (relative.startsWith('/')) fail(EXIT.artifactInvalid, 'absolute archive path: ' + relative);
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(EXIT.artifactInvalid, 'unsafe archive path: ' + relative);
  }
  const joined = path.join(base, relative);
  if (!joined.startsWith(base + path.sep)) fail(EXIT.artifactInvalid, 'archive path escapes: ' + relative);
  return joined;
}

function hostPlatform() {
  if (process.platform !== 'linux') fail(EXIT.baseIncompatible, 'host is not linux');
  // The base image pins one Bun; compare the real host version, not the descriptor.
  const bunVersion = process.versions && process.versions.bun ? String(process.versions.bun) : '';
  if (bunVersion !== C.baseBunVersion) {
    fail(EXIT.baseIncompatible, 'host Bun version ' + bunVersion + ' is not the pinned base');
  }
  let arch;
  if (process.arch === 'x64') arch = 'x64';
  else if (process.arch === 'arm64') arch = 'arm64';
  else fail(EXIT.baseIncompatible, 'unsupported arch ' + process.arch);
  let libc = 'musl';
  let report;
  try {
    report = process.report && process.report.getReport ? process.report.getReport() : undefined;
  } catch {
    report = undefined;
  }
  if (report && report.header && typeof report.header.glibcVersionRuntime === 'string') {
    libc = 'glibc';
  } else {
    const markers = ['/lib/x86_64-linux-gnu/libc.so.6', '/lib/aarch64-linux-gnu/libc.so.6', '/lib64/libc.so.6'];
    libc = markers.some((marker) => fs.existsSync(marker)) ? 'glibc' : 'musl';
  }
  let cpu = 'baseline';
  try {
    const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
    if (/(^|\s)avx2(\s|$)/.test(info.replace(/:/g, ' '))) cpu = 'modern';
  } catch {
    cpu = 'baseline';
  }
  return { os: 'linux', arch, libc, cpu };
}

function readDescriptor() {
  const raw = process.env.KILO_RUNTIME_DESCRIPTOR;
  if (!raw) fail(EXIT.artifactInvalid, 'missing runtime descriptor');
  let descriptor;
  try {
    descriptor = JSON.parse(raw);
  } catch {
    fail(EXIT.artifactInvalid, 'descriptor is not JSON');
  }
  if (!descriptor || descriptor.format !== C.format || descriptor.bootstrap !== C.bootstrap) {
    fail(EXIT.artifactInvalid, 'unsupported descriptor format');
  }
  if (!Array.isArray(descriptor.artifacts) || descriptor.artifacts.length !== 2) {
    fail(EXIT.artifactInvalid, 'descriptor must carry exactly two artifacts');
  }
  if (!Array.isArray(descriptor.inventory)) fail(EXIT.artifactInvalid, 'descriptor is missing the inventory');
  if (descriptor.abi !== C.baseAbi) fail(EXIT.baseIncompatible, 'base ABI contract mismatch');
  for (const artifact of descriptor.artifacts) {
    if (!artifact || !SHA_RE.test(artifact.sha256)) fail(EXIT.artifactInvalid, 'invalid artifact hash');
  }
  const caps = descriptor.caps;
  if (
    !caps ||
    caps.maxTransferBytes > C.hardCaps.maxTransferBytes ||
    caps.maxExpandedBytes > C.hardCaps.maxExpandedBytes ||
    caps.maxFileCount > C.hardCaps.maxFileCount
  ) {
    fail(EXIT.artifactInvalid, 'descriptor caps exceed the installer hard policy');
  }
  if (!descriptor.cliExecutable || descriptor.cliExecutable.startsWith('/')) {
    fail(EXIT.artifactInvalid, 'invalid cliExecutable');
  }
  const executable = descriptor.inventory.find(
    (entry) => entry[0] === 'cli' && entry[1] === descriptor.cliExecutable
  );
  if (!executable || (executable[2] & 0o111) === 0) {
    fail(EXIT.artifactInvalid, 'cliExecutable must be an executable CLI inventory entry');
  }
  return descriptor;
}

function planAndExtract(tar, staging, caps) {
  let scan;
  try {
    scan = scanRuntimeArchive(tar);
  } catch (error) {
    fail(EXIT.artifactInvalid, error && error.message ? error.message : 'invalid archive');
  }
  if (scan.fileCount > caps.maxFileCount) fail(EXIT.artifactInvalid, 'artifact file count exceeds the declared cap');
  if (scan.expandedBytes > caps.maxExpandedBytes) {
    fail(EXIT.artifactInvalid, 'artifact expanded bytes exceed the declared cap');
  }
  for (const file of scan.files) {
    const destination = safeJoin(staging, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.bytes, { mode: file.mode & 0o777 });
  }
  return scan.fileCount;
}

function verifyInstalled(root, inventory, role) {
  const rootStat = lstatSafe(root);
  if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(EXIT.artifactInvalid, 'installed root is not a real directory: ' + root);
  }
  const expected = new Map();
  for (const entry of inventory) {
    if (entry[0] !== role) continue;
    expected.set(entry[1], entry);
  }
  const expectedDirs = new Set();
  for (const filePath of expected.keys()) {
    let index = filePath.lastIndexOf('/');
    while (index > 0) {
      expectedDirs.add(filePath.slice(0, index));
      index = filePath.lastIndexOf('/', index - 1);
    }
  }
  let seen = 0;
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail(EXIT.artifactInvalid, 'installed runtime contains a link: ' + full);
      if (stat.isDirectory()) {
        const relativeDir = path.relative(root, full).split(path.sep).join('/');
        if (!expectedDirs.has(relativeDir)) {
          fail(EXIT.artifactInvalid, 'unexpected directory: ' + relativeDir);
        }
        walk(full);
        continue;
      }
      if (!stat.isFile()) fail(EXIT.artifactInvalid, 'unexpected non-file: ' + full);
      const relative = path.relative(root, full).split(path.sep).join('/');
      const entry = expected.get(relative);
      if (!entry) fail(EXIT.artifactInvalid, 'unexpected file: ' + relative);
      if (stat.size !== entry[3]) fail(EXIT.artifactInvalid, 'installed file has the wrong size: ' + relative);
      if (sha256Bytes(fs.readFileSync(full)) !== entry[4]) {
        fail(EXIT.artifactInvalid, 'installed file hash mismatch: ' + relative);
      }
      const wantExecutable = (entry[2] & 0o111) !== 0;
      const isExecutable = (stat.mode & 0o111) !== 0;
      if (wantExecutable !== isExecutable) fail(EXIT.artifactInvalid, 'installed file mode mismatch: ' + relative);
      seen += 1;
    }
  };
  walk(root);
  if (seen !== expected.size) fail(EXIT.artifactInvalid, 'installed runtime is missing files for role ' + role);
}

function quarantine(target) {
  const directory = path.join(RESERVED_ROOT, '.quarantine');
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(
    directory,
    path.basename(target) + '-' + Date.now() + '-' + process.pid
  );
  try {
    fs.renameSync(target, destination);
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function readCapped(response, cap) {
  if (!response.body) fail(EXIT.artifactInvalid, 'artifact response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    checkDeadline();
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      try {
        await reader.cancel();
      } catch {}
      fail(EXIT.artifactInvalid, 'artifact transfer exceeds the declared size');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function fetchArtifact(artifact, origin, grant) {
  const url = origin.replace(/\/+$/, '') + C.httpPrefix + artifact.sha256;
  let lastError = null;
  for (let attempt = 1; attempt <= C.attempts; attempt += 1) {
    checkDeadline();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining());
    try {
      const response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + grant },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        fail(EXIT.artifactUnauthorized, 'artifact grant rejected');
      }
      if (!response.ok) {
        lastError = new Error('status ' + response.status);
        continue;
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && !Number.isNaN(Number(contentLength))) {
        const declared = Number(contentLength);
        if (declared < 0 || declared > artifact.transferBytes) {
          fail(EXIT.artifactInvalid, 'content-length exceeds the declared transfer size');
        }
      }
      const bytes = await readCapped(response, artifact.transferBytes);
      if (bytes.length !== artifact.transferBytes) {
        fail(EXIT.artifactInvalid, 'artifact transfer size mismatch');
      }
      if (sha256Bytes(Buffer.from(bytes)) !== artifact.sha256) {
        fail(EXIT.artifactInvalid, 'artifact hash mismatch');
      }
      return bytes;
    } catch (error) {
      if (error instanceof Fail) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  fail(
    EXIT.artifactUnavailable,
    'artifact unavailable: ' + (lastError && lastError.message ? lastError.message : 'unknown')
  );
}

async function stage(targetRoot, artifact, inventory, role, origin, grant, caps) {
  const target = path.join(targetRoot, artifact.sha256);
  const existing = lstatSafe(target);
  if (existing !== null) {
    if (!existing.isSymbolicLink() && existing.isDirectory()) {
      try {
        verifyInstalled(target, inventory, role);
        return target;
      } catch (error) {
        if (!(error instanceof Fail)) throw error;
        // Corrupt installed contents: quarantine and repair from authoritative bytes.
        quarantine(target);
      }
    } else {
      quarantine(target);
    }
  }
  const bytes = await fetchArtifact(artifact, origin, grant);
  checkDeadline();
  let tar;
  try {
    tar = zlib.gunzipSync(bytes, { maxOutputLength: C.hardCaps.maxExpandedBytes });
  } catch {
    fail(EXIT.artifactInvalid, 'artifact is not valid gzip within the expansion cap');
  }
  const staging = fs.mkdtempSync(path.join(targetRoot, '.staging-'));
  try {
    planAndExtract(tar, staging, caps);
    verifyInstalled(staging, inventory, role);
    try {
      fs.renameSync(staging, target);
    } catch {
      // A concurrent installer created the target; accept it only if it verifies.
      verifyInstalled(target, inventory, role);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  verifyInstalled(target, inventory, role);
  return target;
}

function verifyRelease(releaseDir, cliSha, controlSha) {
  const pairs = [
    ['cli', CLI_ROOT, cliSha],
    ['control', CONTROL_ROOT, controlSha],
  ];
  for (const [link, root, sha] of pairs) {
    const linkPath = path.join(releaseDir, link);
    const stat = lstatSafe(linkPath);
    if (stat === null || !stat.isSymbolicLink()) fail(EXIT.artifactInvalid, 'release ' + link + ' is not a link');
    const resolved = fs.realpathSync(linkPath);
    if (resolved !== path.join(root, sha)) fail(EXIT.artifactInvalid, 'release ' + link + ' points elsewhere');
  }
}

function ensureRelease(cliSha, controlSha) {
  const releaseId = cliSha + '-' + controlSha;
  const releaseDir = path.join(RELEASES_ROOT, releaseId);
  const existing = lstatSafe(releaseDir);
  if (existing !== null) {
    try {
      verifyRelease(releaseDir, cliSha, controlSha);
      return releaseDir;
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      quarantine(releaseDir);
    }
  }
  const staging = fs.mkdtempSync(path.join(RELEASES_ROOT, '.staging-'));
  try {
    fs.symlinkSync(path.relative(staging, path.join(CLI_ROOT, cliSha)), path.join(staging, 'cli'));
    fs.symlinkSync(
      path.relative(staging, path.join(CONTROL_ROOT, controlSha)),
      path.join(staging, 'control')
    );
    verifyRelease(staging, cliSha, controlSha);
    try {
      fs.renameSync(staging, releaseDir);
    } catch {
      verifyRelease(releaseDir, cliSha, controlSha);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  verifyRelease(releaseDir, cliSha, controlSha);
  return releaseDir;
}

function activate(releaseDir) {
  const relative = path.relative(RESERVED_ROOT, releaseDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(EXIT.artifactInvalid, 'release escapes the reserved root');
  }
  const existing = lstatSafe(ACTIVE_POINTER);
  if (existing !== null && existing.isDirectory()) {
    fail(EXIT.artifactInvalid, 'active pointer is a directory');
  }
  // Read the previous active release before switching, so retention keeps the
  // exact set it supersedes rather than whichever release is newest by mtime.
  let previousId = null;
  if (existing !== null && existing.isSymbolicLink()) {
    const target = fs.readlinkSync(ACTIVE_POINTER);
    const resolved = path.resolve(RESERVED_ROOT, target);
    if (inside(resolved, RELEASES_ROOT)) previousId = path.basename(resolved);
  }
  const temporary = path.join(RESERVED_ROOT, '.active-' + process.pid + '-' + Date.now());
  fs.symlinkSync(relative, temporary);
  fs.renameSync(temporary, ACTIVE_POINTER);
  return previousId;
}

function writeAlias(aliasPath, target) {
  assertRealDirChain(path.dirname(aliasPath));
  const existing = lstatSafe(aliasPath);
  if (existing !== null) {
    if (existing.isDirectory()) fail(EXIT.artifactInvalid, 'alias path is a directory: ' + aliasPath);
    if (existing.isSymbolicLink()) {
      // Validate the lexical link target, not a dereference: an alias may be
      // dangling after a rollback or an interrupted pre-activation.
      const link = fs.readlinkSync(aliasPath);
      const resolved = path.resolve(path.dirname(aliasPath), link);
      if (!inside(resolved, RESERVED_ROOT)) {
        fail(EXIT.artifactInvalid, 'alias points outside the reserved root: ' + aliasPath);
      }
    }
  }
  const temporary = aliasPath + '.tmp-' + process.pid + '-' + Date.now();
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, aliasPath);
}

function installAliases(inventory) {
  const credentialRelative = path.relative(path.sep, C.credentialHelperRealPath);
  for (const entry of inventory) {
    if (entry[0] !== 'control') continue;
    const controlPath = entry[1];
    let aliasPath = null;
    if (controlPath.startsWith('usr/local/bin/')) {
      aliasPath = path.join(ALIAS_DIR, controlPath.slice('usr/local/bin/'.length));
    } else if (controlPath === credentialRelative) {
      aliasPath = C.credentialHelperRealPath;
    }
    if (aliasPath === null) continue;
    writeAlias(aliasPath, path.join(ACTIVE_POINTER, 'control', controlPath));
  }
}

function isReleaseDir(name) {
  const dir = path.join(RELEASES_ROOT, name);
  const stat = lstatSafe(dir);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  for (const link of ['cli', 'control']) {
    const linkPath = path.join(dir, link);
    const linkStat = lstatSafe(linkPath);
    if (linkStat === null || !linkStat.isSymbolicLink()) return false;
    const resolved = path.resolve(dir, fs.readlinkSync(linkPath));
    if (!inside(resolved, RESERVED_ROOT)) return false;
  }
  return true;
}

function pruneReleases(activeId, previousId, managedAliases) {
  const releases = fs.readdirSync(RELEASES_ROOT).filter((name) => !name.startsWith('.'));
  // Keep the active release and its actual predecessor when the active changed. On
  // a same-release boot the active is unchanged, so keep the newest verified
  // rollback already present (at most two releases). Non-release directories are
  // never retained.
  const keep = new Set([activeId]);
  if (previousId !== null && previousId !== activeId && isReleaseDir(previousId)) {
    keep.add(previousId);
  } else {
    const rollback = releases
      .filter((name) => name !== activeId && isReleaseDir(name))
      .sort(
        (left, right) =>
          fs.statSync(path.join(RELEASES_ROOT, right)).mtimeMs -
          fs.statSync(path.join(RELEASES_ROOT, left)).mtimeMs
      )[0];
    if (rollback) keep.add(rollback);
  }
  for (const name of releases) {
    if (!keep.has(name)) fs.rmSync(path.join(RELEASES_ROOT, name), { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(RELEASES_ROOT)) {
    if (name.startsWith('.staging-')) fs.rmSync(path.join(RELEASES_ROOT, name), { recursive: true, force: true });
  }
  for (const root of [CLI_ROOT, CONTROL_ROOT]) {
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('.staging-')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
  for (const name of fs.readdirSync(RESERVED_ROOT)) {
    if (/^\.active-\d+-\d+$/.test(name)) fs.unlinkSync(path.join(RESERVED_ROOT, name));
  }
  // Only our own alias temporaries, matched exactly and removed directly; never a
  // recursive removal in an alias directory outside the reserved root.
  for (const directory of [ALIAS_DIR, RESERVED_ROOT]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const match = /^(.*)\.tmp-\d+-\d+$/.exec(name);
      if (match && managedAliases.has(match[1])) fs.unlinkSync(path.join(directory, name));
    }
  }
  // Quarantine holds corrupt trees that a successful activation made unnecessary.
  fs.rmSync(path.join(RESERVED_ROOT, '.quarantine'), { recursive: true, force: true });
  const referenced = { cli: new Set(), control: new Set() };
  for (const name of keep) {
    for (const link of ['cli', 'control']) {
      try {
        referenced[link].add(path.basename(fs.realpathSync(path.join(RELEASES_ROOT, name, link))));
      } catch {}
    }
  }
  for (const [root, role] of [
    [CLI_ROOT, 'cli'],
    [CONTROL_ROOT, 'control'],
  ]) {
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('.')) continue;
      if (!referenced[role].has(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
}

async function main() {
  const budgetRaw = process.env.KILO_RUNTIME_DEADLINE_MS;
  const budget = budgetRaw === undefined || budgetRaw === '' ? C.defaultDeadlineMs : Number(budgetRaw);
  if (!Number.isFinite(budget) || budget < 0 || budget > C.maxDeadlineMs) {
    fail(EXIT.artifactInvalid, 'invalid deadline budget');
  }
  // One absolute creation deadline: the earlier of the existing policy budget
  // and the deadline the launch options carried in. Phase steps do not reset it.
  const absoluteRaw = process.env.KILO_RUNTIME_DEADLINE_AT;
  let policyDeadline = Date.now() + budget;
  if (absoluteRaw !== undefined && absoluteRaw !== '') {
    const absolute = Number(absoluteRaw);
    if (!Number.isFinite(absolute) || absolute <= 0) {
      fail(EXIT.artifactInvalid, 'invalid absolute deadline');
    }
    policyDeadline = Math.min(policyDeadline, absolute);
  }
  deadlineAt = policyDeadline;
  const descriptor = readDescriptor();
  const host = hostPlatform();
  if (host.os !== descriptor.platform.os || host.arch !== descriptor.platform.arch) {
    fail(EXIT.baseIncompatible, 'host platform is incompatible');
  }
  if (host.libc !== descriptor.platform.libc) fail(EXIT.baseIncompatible, 'host libc is incompatible');
  if (descriptor.platform.cpu === 'modern' && host.cpu !== 'modern') {
    fail(EXIT.baseIncompatible, 'host CPU tier is incompatible');
  }
  const grant = process.env.KILO_RUNTIME_ARTIFACT_GRANT;
  const origin = process.env.KILO_RUNTIME_ARTIFACT_ORIGIN;
  if (!grant || !origin) fail(EXIT.artifactInvalid, 'missing artifact origin or grant');
  if (!origin.startsWith('https://') && process.env.KILO_RUNTIME_ALLOW_INSECURE_ORIGIN !== '1') {
    fail(EXIT.artifactInvalid, 'artifact origin must be https');
  }
  const cli = descriptor.artifacts.find((artifact) => artifact.role === 'cli');
  const control = descriptor.artifacts.find((artifact) => artifact.role === 'control');
  if (!cli || !control) fail(EXIT.artifactInvalid, 'descriptor must carry cli and control artifacts');

  assertRealDirChain(RESERVED_ROOT);
  assertRealDirChain(CLI_ROOT);
  assertRealDirChain(CONTROL_ROOT);
  assertRealDirChain(RELEASES_ROOT);

  await stage(CLI_ROOT, cli, descriptor.inventory, 'cli', origin, grant, descriptor.caps);
  await stage(CONTROL_ROOT, control, descriptor.inventory, 'control', origin, grant, descriptor.caps);
  const releaseDir = ensureRelease(cli.sha256, control.sha256);
  installAliases(descriptor.inventory);
  const managedAliases = new Set();
  for (const entry of descriptor.inventory) {
    if (entry[0] === 'control' && entry[1].startsWith('usr/local/bin/')) {
      managedAliases.add(entry[1].slice('usr/local/bin/'.length));
    }
  }
  managedAliases.add(path.basename(C.credentialHelperRealPath));
  const previousId = activate(releaseDir);
  pruneReleases(path.basename(releaseDir), previousId, managedAliases);

  const cliPath = path.join(ACTIVE_POINTER, 'cli', descriptor.cliExecutable);
  const cliStat = lstatSafe(cliPath);
  if (cliStat === null || !cliStat.isFile() || cliStat.isSymbolicLink()) {
    fail(EXIT.artifactInvalid, 'CLI executable is missing: ' + descriptor.cliExecutable);
  }
  process.stdout.write(cliPath + '\n');
}

main().catch((error) => {
  const code = error instanceof Fail ? error.code : EXIT.installInterrupted;
  process.stderr.write('runtime-installer: ' + (error && error.message ? error.message : 'error') + '\n');
  process.exit(code);
});
`;

/** The full Bun installer program embedded in the launch command. */
const RUNTIME_INSTALLER_SOURCE = `${RUNTIME_INSTALLER_HEADER}\n${RUNTIME_ARCHIVE_SCANNER_SOURCE}\n${RUNTIME_INSTALLER_CONTRACT}\n${RUNTIME_INSTALLER_BODY}`;

/**
 * The bounded CLI probe and handoff program embedded in the launch command. It
 * runs after the parent shell clears the artifact grant and the absolute
 * deadline env, so neither the probe nor its child inherits the grant. One
 * `Bun.spawn` timeout bounds the probe with no separate timer process. On
 * success it writes the handoff receipt before returning, under the validated
 * real reserved root and with exclusive create, so the handoff is committed
 * before the parent shell execs the supervisor.
 */
const RUNTIME_LAUNCH_PROBE_SOURCE = String.raw`
import fs from 'node:fs';

const [cliPath, deadlineRaw, reservedRoot, launchId] = process.argv.slice(2);
const deadlineAt = deadlineRaw ? Number(deadlineRaw) : 0;
const expired = () => deadlineAt > 0 && Date.now() >= deadlineAt;
if (expired()) process.exit(${RUNTIME_INSTALLER_EXIT.deadlineExceeded});

const remaining = deadlineAt > 0 ? deadlineAt - Date.now() : 0;
let code = -1;
try {
  const proc = Bun.spawn({
    cmd: [cliPath, '--version'],
    stdout: 'ignore',
    stderr: 'ignore',
    killSignal: 'SIGKILL',
    ...(remaining > 0 ? { timeout: remaining } : {}),
  });
  code = await proc.exited;
} catch {
  code = -1;
}
if (code !== 0) {
  process.exit(expired() ? ${RUNTIME_INSTALLER_EXIT.deadlineExceeded} : ${RUNTIME_INSTALLER_EXIT.cliProbeFailed});
}
if (expired()) process.exit(${RUNTIME_INSTALLER_EXIT.deadlineExceeded});

let root;
try {
  const stat = fs.lstatSync(reservedRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) process.exit(${RUNTIME_INSTALLER_EXIT.installInterrupted});
  root = fs.realpathSync(reservedRoot);
} catch {
  process.exit(${RUNTIME_INSTALLER_EXIT.installInterrupted});
}
const dir = root + '/' + ${JSON.stringify(RUNTIME_LAUNCH_RECEIPT_DIR_NAME)};
try {
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) process.exit(${RUNTIME_INSTALLER_EXIT.installInterrupted});
    fs.chmodSync(dir, 0o700);
  } else {
    fs.mkdirSync(dir, { mode: 0o700 });
  }
} catch {
  process.exit(${RUNTIME_INSTALLER_EXIT.installInterrupted});
}
try {
  fs.writeFileSync(dir + '/' + launchId + '.json', JSON.stringify({ launchId, outcome: 'handoff' }), {
    flag: 'wx',
    mode: 0o600,
  });
} catch {
  process.exit(${RUNTIME_INSTALLER_EXIT.installInterrupted});
}
process.exit(0);
`;

/** Options for one launch command. Both fields come from the launch provider. */
export type RuntimeLaunchOptions = {
  /** Random per-launch nonce. A missing value generates one for a default command. */
  launchId?: string;
  /** Absolute epoch-ms creation deadline covering install, probe, and handoff. */
  deadlineAt?: number;
};

/**
 * The serialized launch command. The shell writes the embedded Bun programs to a
 * fresh temporary directory, runs the installer with the absolute deadline, then
 * runs the bounded probe. The launch id and deadline travel in the command text,
 * never from a profile environment value. On any installer, probe, or supervisor
 * failure the shell writes one typed failure receipt after cleanup; on success
 * the probe writes the handoff receipt and the shell execs the supervisor as the
 * same parent-shell process, so no phase timer survives into the supervisor.
 */
export function runtimeLaunchCommand(options: RuntimeLaunchOptions = {}): string {
  const launchId = options.launchId ?? crypto.randomUUID();
  if (!RUNTIME_LAUNCH_ID_PATTERN.test(launchId)) {
    throw new Error('runtime launch id must match the bounded nonce alphabet');
  }
  const { deadlineAt } = options;
  if (deadlineAt !== undefined && !Number.isInteger(deadlineAt)) {
    throw new Error('runtime launch deadlineAt must be an integer epoch-ms value');
  }
  const installerCodes = Object.values(RUNTIME_INSTALLER_EXIT).join('|');
  return [
    'set -eu',
    `launch_id='${launchId}'`,
    `deadline_at='${deadlineAt === undefined ? '' : deadlineAt}'`,
    `reserved_root="\${${RUNTIME_RESERVED_ROOT_ENV}:-${RUNTIME_RESERVED_ROOT}}"`,
    `receipt_dir=''`,
    'prepare_receipt_dir() {',
    '  if [ ! -d "$reserved_root" ] || [ -L "$reserved_root" ]; then return 0; fi',
    '  resolved=$(cd "$reserved_root" 2>/dev/null && pwd -P) || return 0',
    '  if [ -z "$resolved" ]; then return 0; fi',
    `  candidate="$resolved/${RUNTIME_LAUNCH_RECEIPT_DIR_NAME}"`,
    '  if [ -e "$candidate" ]; then',
    '    if [ -L "$candidate" ] || [ ! -d "$candidate" ]; then return 0; fi',
    '    chmod 700 "$candidate" 2>/dev/null || true',
    '  else',
    '    ( umask 077; mkdir "$candidate" ) 2>/dev/null || return 0',
    '  fi',
    '  receipt_dir="$candidate"',
    '}',
    'write_failure_receipt() {',
    '  if [ -z "$receipt_dir" ]; then prepare_receipt_dir; fi',
    '  if [ -z "$receipt_dir" ]; then return 0; fi',
    `  ( umask 077; set -C; printf '{"launchId":"%s","outcome":"installer_failed","code":%s}' "$launch_id" "$1" > "$receipt_dir/$launch_id.json" ) 2>/dev/null || true`,
    '}',
    'fail_phase() {',
    '  rm -rf "$dir"',
    '  trap - EXIT',
    '  write_failure_receipt "$1"',
    '  exit "$1"',
    '}',
    'prepare_receipt_dir',
    'dir=$(mktemp -d)',
    `trap 'rm -rf "$dir"' EXIT`,
    `cat > "$dir/install.mjs" <<'KILO_RUNTIME_INSTALLER_EOF'`,
    RUNTIME_INSTALLER_SOURCE,
    'KILO_RUNTIME_INSTALLER_EOF',
    `cat > "$dir/probe.mjs" <<'KILO_RUNTIME_PROBE_EOF'`,
    RUNTIME_LAUNCH_PROBE_SOURCE,
    'KILO_RUNTIME_PROBE_EOF',
    `if [ -n "$deadline_at" ]; then ${RUNTIME_DEADLINE_AT_ENV}="$deadline_at"; export ${RUNTIME_DEADLINE_AT_ENV}; else unset ${RUNTIME_DEADLINE_AT_ENV}; fi`,
    'set +e',
    'cli_path=$(bun run "$dir/install.mjs")',
    'installer_rc=$?',
    'set -e',
    'if [ "$installer_rc" -ne 0 ]; then',
    `  case "$installer_rc" in ${installerCodes}) fail_phase "$installer_rc" ;; *) rm -rf "$dir"; trap - EXIT; exit "$installer_rc" ;; esac`,
    'fi',
    `unset ${RUNTIME_DEADLINE_AT_ENV}`,
    `unset ${RUNTIME_ARTIFACT_GRANT_ENV}`,
    `if [ -z "$cli_path" ]; then fail_phase ${RUNTIME_INSTALLER_EXIT.cliProbeFailed}; fi`,
    `${RUNTIME_CLI_PATH_ENV}="$cli_path"`,
    `export ${RUNTIME_CLI_PATH_ENV}`,
    `supervisor="\${${RUNTIME_ALIAS_DIR_ENV}:-${RUNTIME_ALIAS_DIR}}/${CONTROL_PLANE_SUPERVISOR.installName}"`,
    `if [ ! -e "$supervisor" ]; then fail_phase ${RUNTIME_INSTALLER_EXIT.supervisorMissing}; fi`,
    'set +e',
    `bun run "$dir/probe.mjs" "$cli_path" "$deadline_at" "$reserved_root" "$launch_id"`,
    'probe_rc=$?',
    'set -e',
    'if [ "$probe_rc" -ne 0 ]; then',
    `  case "$probe_rc" in ${RUNTIME_INSTALLER_EXIT.deadlineExceeded}) fail_phase ${RUNTIME_INSTALLER_EXIT.deadlineExceeded} ;; ${RUNTIME_INSTALLER_EXIT.installInterrupted}) fail_phase ${RUNTIME_INSTALLER_EXIT.installInterrupted} ;; *) fail_phase ${RUNTIME_INSTALLER_EXIT.cliProbeFailed} ;; esac`,
    'fi',
    'rm -rf "$dir"',
    'trap - EXIT',
    'exec /bin/sh "$supervisor"',
  ].join('\n');
}
