import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { openPackage, sha256 } from '../../pages/scripts/pinned.mjs';
import { archiveOf, goodMembers } from '../../pages/scripts/test-archive.mjs';
import { buildShell, receiptProblems, shellConfigProblems } from './shell.mjs';

const committed = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

/** The `output/wrangler.json` a Pages package ships. */
const packaged = () => ({ main: 'worker.js', no_bundle: true, compatibility_date: '2026-11-15' });

test('the committed configuration matches the package', () => {
  assert.deepEqual(shellConfigProblems(packaged(), committed), []);
});

test('the shell holds no bindings, variables or secrets', () => {
  // What this deployment decides, beside the package's structural fields. A
  // binding or variable here would hand a credential or data to the origin
  // that runs widget code.
  const allowed = [
    '$schema',
    'account_id',
    'name',
    'workers_dev',
    'preview_urls',
    'routes',
    'observability',
    ...Object.keys(packaged()),
  ];
  assert.deepEqual(
    Object.keys(committed).filter(name => !allowed.includes(name)),
    []
  );
});

const drift = {
  'another compatibility date': [
    'compatibility_date',
    config => (config.compatibility_date = '2027-01-01'),
  ],
  'a bundled module': ['no_bundle', config => (config.no_bundle = false)],
  'another module file': ['main', config => (config.main = 'index.js')],
  'a field the package adds': [
    'compatibility_flags',
    config => (config.compatibility_flags = ['nodejs_compat']),
  ],
};

for (const [name, [field, change]] of Object.entries(drift))
  test(`reports ${name}`, () => {
    const config = packaged();
    change(config);
    assert.deepEqual(shellConfigProblems(config, committed), [
      `${field} in wrangler.jsonc differs from the package's output/wrangler.json`,
    ]);
  });

const MODULE_TEXT = 'export default { fetch() { return new Response("ok"); } }';
const digest = sha256(Buffer.from(MODULE_TEXT));
const receipt = () => ({
  build_id: '0123456789ab',
  source_sha: 'f'.repeat(40),
  output_files: { 'output/worker.js': digest },
  output_frame_paths: ['/frame/v2/'],
});

test('a receipt that certifies the module passes', () => {
  assert.deepEqual(receiptProblems(receipt(), digest), []);
});

const badReceipts = {
  'no output_files': [r => delete r.output_files, ['The build receipt has no output_files']],
  'another file in output_files': [
    r => (r.output_files['output/extra.js'] = digest),
    [
      'The build receipt\'s output_files must name output/worker.js alone, not "output/worker.js, output/extra.js"',
    ],
  ],
  'a digest of another module': [
    r => (r.output_files['output/worker.js'] = '0'.repeat(64)),
    [`output/worker.js has sha256 ${digest}, but the build receipt certifies ${'0'.repeat(64)}`],
  ],
  'a digest that is not one': [
    r => (r.output_files['output/worker.js'] = 'x\n::add-mask::y'),
    ["The build receipt's sha256 for output/worker.js is not a digest"],
  ],
  'no frame paths': [
    r => (r.output_frame_paths = []),
    ["The build receipt's output_frame_paths must list frame paths such as /frame/v2/"],
  ],
  'a frame path that is not a directory': [
    r => (r.output_frame_paths = ['https://example.com/frame/v2/']),
    ["The build receipt's output_frame_paths must list frame paths such as /frame/v2/"],
  ],
};

for (const [name, [change, expected]] of Object.entries(badReceipts))
  test(`refuses a receipt with ${name}`, () => {
    const changed = receipt();
    change(changed);
    assert.deepEqual(receiptProblems(changed, digest), expected);
  });

/** A package holding `module` as the shell, its receipt certifying `certified`. */
function shellArchive({ module = MODULE_TEXT, config = packaged(), certified = digest } = {}) {
  const contents = {
    'build-receipt.json': JSON.stringify({
      ...receipt(),
      output_files: { 'output/worker.js': certified },
    }),
    'output/worker.js': module,
    'output/wrangler.json': JSON.stringify(config),
  };
  const archive = archiveOf(goodMembers.map(([name, data]) => [name, contents[name] ?? data]));
  return {
    archive,
    source: { repository: 'nteract/nteract', tag: 'pages-0123456789ab', sha256: sha256(archive) },
  };
}

/** A scratch copy of this folder's layout for `buildShell` to fill. */
function serviceDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'pages-output-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('builds dist from the shell module alone', async t => {
  const service = serviceDirectory(t);
  const { archive, source } = shellArchive();
  const summary = await openPackage(archive, source, opened =>
    buildShell(opened, committed, service)
  );
  assert.deepEqual(readdirSync(path.join(service, 'dist')), ['worker.js']);
  assert.equal(readFileSync(path.join(service, committed.main), 'utf8'), MODULE_TEXT);
  assert.equal(summary.worker, 'nteract-pages-outputs');
  assert.equal(summary.build_id, '0123456789ab');
  assert.deepEqual(summary.frame_paths, ['/frame/v2/']);
});

test('refuses a module the receipt does not certify', async t => {
  const service = serviceDirectory(t);
  const { archive, source } = shellArchive({ module: 'export default {}' });
  await assert.rejects(
    openPackage(archive, source, opened => buildShell(opened, committed, service)),
    /output\/worker\.js has sha256 [0-9a-f]{64}, but the build receipt certifies/
  );
  assert.deepEqual(readdirSync(service), []);
});

test('refuses a shell whose configuration differs', async t => {
  const service = serviceDirectory(t);
  const { archive, source } = shellArchive({
    config: { ...packaged(), compatibility_date: '2027-01-01' },
  });
  await assert.rejects(
    openPackage(archive, source, opened => buildShell(opened, committed, service)),
    /^Error: compatibility_date in wrangler\.jsonc differs from the package's output\/wrangler\.json$/
  );
  assert.deepEqual(readdirSync(service), []);
});
