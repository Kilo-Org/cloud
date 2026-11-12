// What a released Pages package must look like before its files reach `dist/`.
//
// nteract publishes Pages as a release asset: a gzipped ustar archive holding
// the Worker modules, the browser assets, a build receipt and a
// deployment-neutral `wrangler.json`. That file carries only what the code
// fixes (Durable Object classes, migrations, cron triggers, asset handling).
// `wrangler.jsonc` in this folder adds what this deployment decides (name,
// account, route, databases, bucket, variables) and is what deploys.
// `configProblems` reports every structural field where the two disagree.
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';

// Where `pnpm run build` puts the package, relative to `wrangler.jsonc`.
export const OUTPUT = 'dist';
const PACKAGE_ENTRIES = ['build-receipt.json', 'public', 'worker', 'wrangler.json'];

export const TAG = /^pages-([0-9a-f]{12})$/;
export const SHA256 = /^[0-9a-f]{64}$/;

/** The archive a release tag publishes: `pages-<build_id>` holds
 * `pages-package-<build_id>.tar.gz`. */
export function archiveName(tag) {
  const [, buildId] = TAG.exec(tag) ?? [];
  if (!buildId) throw new Error(`${tag} is not a Pages release tag (pages-<build_id>)`);
  return `pages-package-${buildId}.tar.gz`;
}

// Every member path of a Pages package. Anything else, including `.` and `..`
// components, is refused before a file is written.
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]*';
const MEMBER = new RegExp(
  `^(build-receipt\\.json|wrangler\\.json|worker/${SEGMENT}|public/(${SEGMENT}/)*${SEGMENT})$`
);

const field = (header, start, length) => {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? length : end).toString('utf8');
};

/** The files of a gzipped ustar archive, as package path → bytes, and every
 * reason it is not a Pages package. Only regular files are accepted: a link,
 * a directory entry or any other member type is a problem, not a file. */
export function readArchive(gzipped) {
  const tar = gunzipSync(gzipped);
  const files = new Map();
  const problems = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const stored = Number.parseInt(field(header, 148, 8).trim(), 8);
    const sum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    if (stored !== sum) return { files, problems: ['The archive has a corrupt header'] };
    if (field(header, 257, 6) !== 'ustar')
      return { files, problems: ['The archive is not a ustar archive'] };
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const member = prefix ? `${prefix}/${name}` : name;
    // ustar stores the size as octal digits. Anything else, such as a sign,
    // would let `offset` stand still or move back.
    const sizeField = field(header, 124, 12).trim();
    if (!/^[0-7]*$/.test(sizeField))
      return { files, problems: [`${field(header, 0, 100)} has an invalid size`] };
    const size = Number.parseInt(sizeField || '0', 8);
    const type = String.fromCharCode(header[156]);
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || start + size > tar.length)
      return { files, problems: ['The archive is truncated'] };
    offset = start + Math.ceil(size / 512) * 512;

    if (type !== '0' && type !== '\0') problems.push(`${member} is not a regular file`);
    else if (!MEMBER.test(member)) problems.push(`${member} is not part of a Pages package`);
    else if (files.has(member)) problems.push(`${member} appears twice`);
    else files.set(member, tar.subarray(start, start + size));
  }
  return { files, problems };
}

/** Every structural field where `committed` (this folder's `wrangler.jsonc`)
 * differs from `packaged` (the package's `wrangler.json`); empty when they
 * agree. The package's paths are relative to the package, the committed ones
 * to this folder, so `main` and `assets.directory` differ by the `OUTPUT`
 * prefix. `vars` is compared by the keys the package names; every other
 * variable belongs to this deployment. */
export function configProblems(packaged, committed) {
  const expected = {
    ...packaged,
    main: `${OUTPUT}/${packaged.main}`,
    assets: { ...packaged.assets, directory: `${OUTPUT}/${packaged.assets?.directory}` },
  };
  const problems = [];
  for (const name of Object.keys(expected).sort()) {
    if (name === 'vars') {
      for (const [key, value] of Object.entries(expected.vars ?? {}))
        if (committed.vars?.[key] !== value)
          problems.push(
            `vars.${key} in wrangler.jsonc differs from what the Pages package expects`
          );
    } else if (!isDeepStrictEqual(expected[name], committed[name]))
      problems.push(`${name} in wrangler.jsonc differs from what the Pages package expects`);
  }
  return problems;
}

/** Every entry in an extracted package directory that is out of place.
 * `dist/worker` is attached to the Worker as modules and `dist/public` is
 * served as assets, so a symlink there would publish a file from the machine
 * that deploys. */
export function packageFileProblems(directory) {
  const problems = [];
  const kind = file => {
    const stat = lstatSync(file);
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  };
  const walk = relative => {
    for (const name of readdirSync(path.join(directory, relative)).sort()) {
      const entry = path.join(relative, name);
      const found = kind(path.join(directory, entry));
      if (found === 'other') problems.push(`${entry} must be a regular file or a directory`);
      else if (found === 'directory' && relative === 'worker')
        problems.push(`${entry} must be a file: worker holds only modules`);
      else if (found === 'directory') walk(entry);
    }
  };

  const present = readdirSync(directory).sort();
  for (const name of present)
    if (!PACKAGE_ENTRIES.includes(name)) problems.push(`${name} is not part of a Pages package`);
  for (const name of PACKAGE_ENTRIES)
    if (!present.includes(name)) problems.push(`The package has no ${name}`);
  if (problems.length) return problems;

  for (const name of PACKAGE_ENTRIES) {
    const expected = name.endsWith('.json') ? 'file' : 'directory';
    if (kind(path.join(directory, name)) !== expected)
      problems.push(`${name} must be a ${expected}`);
  }
  if (problems.length) return problems;

  walk('worker');
  walk('public');
  if (!readdirSync(path.join(directory, 'worker')).includes('index.js'))
    problems.push('The package has no worker/index.js');
  return problems;
}
