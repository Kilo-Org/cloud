import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parse } from 'jsonc-parser';
import {
  archiveName,
  configProblems,
  packageFileProblems,
  printable,
  readArchive,
} from './package.mjs';
import { archiveOf, goodMembers } from './test-archive.mjs';

const committed = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

/** The deployment-neutral `wrangler.json` a Pages package ships for this
 * deployment: the committed structural fields, with paths relative to the
 * package and only the variables the code fixes. */
function packaged() {
  const config = structuredClone(committed);
  return {
    main: 'worker/index.js',
    no_bundle: config.no_bundle,
    compatibility_date: config.compatibility_date,
    assets: { ...config.assets, directory: 'public' },
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    triggers: config.triggers,
    vars: { NOTEBOOK_CLOUD_OIDC_FLOW: config.vars.NOTEBOOK_CLOUD_OIDC_FLOW },
    preview_urls: config.preview_urls,
    observability: config.observability,
  };
}

test('the committed configuration matches the package', () => {
  assert.deepEqual(configProblems(packaged(), committed), []);
});

test('fields this deployment decides are not compared', () => {
  const config = structuredClone(committed);
  config.name = 'another-worker';
  config.vars.PAGES_DEFAULT_PAGE_QUOTA = '1';
  config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
  assert.deepEqual(configProblems(packaged(), config), []);
});

const drift = {
  'a new Durable Object class': [
    'durable_objects',
    config => config.durable_objects.bindings.push({ name: 'NEW', class_name: 'New' }),
  ],
  'a new migration': [
    'migrations',
    config => config.migrations.push({ tag: 'v4', new_sqlite_classes: ['New'] }),
  ],
  'a changed cron trigger': ['triggers', config => (config.triggers.crons[0] = '0 0 * * *')],
  'a field the package adds': [
    'compatibility_flags',
    config => (config.compatibility_flags = ['nodejs_compat']),
  ],
  'another entry module': ['main', config => (config.main = 'index.js')],
  'another assets directory': ['assets', config => (config.assets.directory = 'static')],
  'a changed structural variable': [
    'vars.NOTEBOOK_CLOUD_OIDC_FLOW',
    config => (config.vars.NOTEBOOK_CLOUD_OIDC_FLOW = 'client'),
  ],
};

for (const [name, [field, change]] of Object.entries(drift)) {
  test(`reports ${name}`, () => {
    const config = packaged();
    change(config);
    assert.deepEqual(configProblems(config, committed), [
      `${field} in wrangler.jsonc differs from what the Pages package expects`,
    ]);
  });
}

test('a release tag names its archive', () => {
  assert.equal(archiveName('pages-0123456789ab'), 'pages-package-0123456789ab.tar.gz');
  assert.throws(() => archiveName('v2.10.0-nightly.202611112112'), /not a Pages release tag/);
});

test('reads the members of a Pages package', () => {
  const { files, problems } = readArchive(archiveOf(goodMembers));
  assert.deepEqual(problems, []);
  assert.deepEqual(
    [...files.keys()],
    goodMembers.map(([name]) => name)
  );
  assert.equal(files.get('worker/index.js').toString(), 'export default {}');
});

const refusedMembers = {
  'a parent directory component': ['public/../../escape.js', 'x'],
  'a dot component': ['public/./index.html', 'x'],
  'an absolute path': ['/etc/hosts', 'x'],
  'a nested module': ['worker/sub/index.js', 'x'],
  'another file under output': ['output/index.html', 'x'],
  'a nested output file': ['output/frame/worker.js', 'x'],
  'an output file in another case': ['output/Worker.js', 'x'],
  'a symlinked output module': ['output/worker.js', '', '2'],
  'a file outside the layout': ['.env', 'x'],
  'a symlink': ['public/hosts.js', '', '2'],
  'a hard link': ['public/hosts.js', '', '1'],
  'a directory entry': ['public/chunks', '', '5'],
};

for (const [name, member] of Object.entries(refusedMembers)) {
  test(`refuses an archive with ${name}`, () => {
    const { problems } = readArchive(archiveOf([...goodMembers, member]));
    assert.equal(problems.length, 1);
  });
}

test('refuses a member that appears twice', () => {
  const { problems } = readArchive(archiveOf([...goodMembers, ['worker/index.js', 'again']]));
  assert.deepEqual(problems, ['worker/index.js appears twice']);
});

test('refuses an output file that appears twice', () => {
  const { problems } = readArchive(archiveOf([...goodMembers, ['output/worker.js', 'again']]));
  assert.deepEqual(problems, ['output/worker.js appears twice']);
});

test('refuses a member that differs from another only in case', () => {
  const { problems } = readArchive(archiveOf([...goodMembers, ['worker/Index.js', 'again']]));
  assert.deepEqual(problems, ['worker/Index.js appears twice']);
});

test('accepts public/_headers', () => {
  const headers = '/*\n  X-Content-Type-Options: nosniff\n';
  const { problems } = readArchive(archiveOf([...goodMembers, ['public/_headers', headers]]));
  assert.deepEqual(problems, []);
});

for (const name of ['public/_redirects', 'public/_worker.js', 'public/chunks/_routes.json'])
  test(`refuses ${name}`, () => {
    const { problems } = readArchive(archiveOf([...goodMembers, [name, '/* https://example.com']]));
    assert.deepEqual(problems, [`${name} would configure the asset server`]);
  });

test('quotes a name that could start a workflow command', () => {
  const name = 'worker/a\n::add-mask::x';
  assert.equal(printable(name), JSON.stringify(name));
  assert.equal(printable('worker/index.js'), 'worker/index.js');
  const { problems } = readArchive(archiveOf([...goodMembers, [name, 'x']]));
  assert.ok(problems.every(problem => !problem.includes('\n')));
});

test('refuses a negative member size instead of reading the header again', () => {
  const { problems } = readArchive(archiveOf([['worker/index.js', '', '0', '-0000001000']]));
  assert.deepEqual(problems, ['worker/index.js has an invalid size']);
});

test('refuses a corrupt header', () => {
  const tar = gunzipSync(archiveOf(goodMembers));
  tar[0] ^= 1;
  assert.deepEqual(readArchive(gzipSync(tar)).problems, ['The archive has a corrupt header']);
});

/** A directory with the entries a Pages package holds. */
function packageDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'pages-package-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'worker'));
  mkdirSync(path.join(directory, 'output'));
  mkdirSync(path.join(directory, 'public', 'chunks'), { recursive: true });
  for (const [file] of goodMembers) writeFileSync(path.join(directory, file), '');
  return directory;
}

test('the entries of a Pages package pass', t => {
  assert.deepEqual(packageFileProblems(packageDirectory(t)), []);
});

const refusedFiles = {
  'a file a package does not hold': directory => writeFileSync(path.join(directory, '.env'), ''),
  'a missing entry module': directory => rmSync(path.join(directory, 'worker/index.js')),
  'a missing public directory': directory =>
    rmSync(path.join(directory, 'public'), { recursive: true }),
  'a directory of modules': directory => mkdirSync(path.join(directory, 'worker/more')),
  'a symlinked module': directory =>
    symlinkSync('/etc/hosts', path.join(directory, 'worker/hosts.js')),
  'a symlinked asset': directory =>
    symlinkSync('/etc/hosts', path.join(directory, 'public/chunks/hosts.js')),
  'a missing output directory': directory =>
    rmSync(path.join(directory, 'output'), { recursive: true }),
  'a missing output module': directory => rmSync(path.join(directory, 'output/worker.js')),
  'a missing output configuration': directory =>
    rmSync(path.join(directory, 'output/wrangler.json')),
  'another file under output': directory =>
    writeFileSync(path.join(directory, 'output/index.html'), ''),
  'a directory under output': directory => mkdirSync(path.join(directory, 'output/frame')),
  'a symlinked output module': directory => {
    rmSync(path.join(directory, 'output/worker.js'));
    symlinkSync('/etc/hosts', path.join(directory, 'output/worker.js'));
  },
  'an output directory that is a file': directory => {
    rmSync(path.join(directory, 'output'), { recursive: true });
    writeFileSync(path.join(directory, 'output'), '');
  },
};

for (const [name, change] of Object.entries(refusedFiles)) {
  test(`refuses ${name}`, t => {
    const directory = packageDirectory(t);
    change(directory);
    assert.notDeepEqual(packageFileProblems(directory), []);
  });
}
