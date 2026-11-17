import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

import { buildSnapshot, submittablePurls } from './dependency-snapshot.mjs';

const scriptPath = fileURLToPath(new URL('./dependency-snapshot.mjs', import.meta.url));
const sha = 'a'.repeat(40);

const bom = {
  bomFormat: 'CycloneDX',
  components: [
    { type: 'library', name: 'undici', purl: 'pkg:npm/undici@8.10.0' },
    // Same package found in a second install location.
    { type: 'library', name: 'undici', purl: 'pkg:npm/undici@8.10.0' },
    { type: 'library', name: '@openclaw/fs-safe', purl: 'pkg:npm/%40openclaw/fs-safe@0.4.7' },
    { type: 'library', name: 'xurl', purl: 'pkg:golang/github.com/xdevplatform/xurl@v1.2.2' },
    {
      type: 'library',
      name: 'okhttp',
      purl: 'pkg:maven/com.squareup.okhttp3/okhttp@4.12.0',
      components: [
        { type: 'library', name: 'okio', purl: 'pkg:maven/com.squareup.okio/okio@3.9.0' },
      ],
    },
    { type: 'library', name: 'apt', purl: 'pkg:deb/debian/apt@3.0.3?arch=amd64&distro=debian-13' },
    { type: 'application', name: 'node', purl: 'pkg:generic/node@24.11.0' },
    { type: 'library', name: 'unversioned', purl: 'pkg:npm/unversioned' },
    { type: 'library', name: '@scope/unversioned', purl: 'pkg:npm/@scope/unversioned' },
    { type: 'library', name: 'empty-version', purl: 'pkg:npm/empty-version@' },
    { type: 'file', name: '/etc/passwd' },
  ],
};

test('keeps one entry per versioned purl of an advisory ecosystem', () => {
  assert.deepEqual(submittablePurls(bom), [
    'pkg:golang/github.com/xdevplatform/xurl@v1.2.2',
    'pkg:maven/com.squareup.okhttp3/okhttp@4.12.0',
    'pkg:maven/com.squareup.okio/okio@3.9.0',
    'pkg:npm/%40openclaw/fs-safe@0.4.7',
    'pkg:npm/undici@8.10.0',
  ]);
});

test('restricts the purl types when asked', () => {
  assert.deepEqual(submittablePurls(bom, ['maven']), [
    'pkg:maven/com.squareup.okhttp3/okhttp@4.12.0',
    'pkg:maven/com.squareup.okio/okio@3.9.0',
  ]);
});

test('builds a submission body under one manifest', () => {
  const snapshot = buildSnapshot({
    purls: ['pkg:npm/undici@8.10.0'],
    manifest: 'services/kiloclaw/Dockerfile',
    source: 'services/kiloclaw/Dockerfile',
    sha,
    ref: 'refs/heads/main',
    correlator: 'dependency-submission-kiloclaw-image',
    runId: '42',
    runUrl: 'https://github.com/o/r/actions/runs/42',
    scanned: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.sha, sha);
  assert.equal(snapshot.ref, 'refs/heads/main');
  assert.deepEqual(snapshot.job, {
    correlator: 'dependency-submission-kiloclaw-image',
    id: '42',
    html_url: 'https://github.com/o/r/actions/runs/42',
  });
  assert.deepEqual(snapshot.manifests, {
    'services/kiloclaw/Dockerfile': {
      name: 'services/kiloclaw/Dockerfile',
      file: { source_location: 'services/kiloclaw/Dockerfile' },
      resolved: {
        'pkg:npm/undici@8.10.0': { package_url: 'pkg:npm/undici@8.10.0', scope: 'runtime' },
      },
    },
  });
});

test('refuses an empty snapshot, which would close every open alert', () => {
  assert.throws(
    () =>
      buildSnapshot({
        purls: [],
        manifest: 'm',
        sha,
        ref: 'refs/heads/main',
        correlator: 'c',
        runId: '1',
        scanned: 'now',
      }),
    /no submittable component/
  );
});

test('refuses a snapshot without a full commit and ref', () => {
  const base = { purls: ['pkg:npm/a@1.0.0'], manifest: 'm', correlator: 'c', runId: '1' };
  assert.throws(() => buildSnapshot({ ...base, sha: 'abc', ref: 'refs/heads/main' }), /sha/);
  assert.throws(() => buildSnapshot({ ...base, sha, ref: 'main' }), /ref/);
});

function runCli(args, env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('the CLI writes the snapshot to stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-snapshot-'));
  const sbom = join(dir, 'sbom.json');
  writeFileSync(sbom, JSON.stringify(bom));
  const result = runCli(
    ['--sbom', sbom, '--manifest', 'm', '--correlator', 'c', '--types', 'golang'],
    { GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '7' }
  );
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(snapshot.manifests.m.resolved), [
    'pkg:golang/github.com/xdevplatform/xurl@v1.2.2',
  ]);
  assert.equal(snapshot.job.id, '7');
  assert.match(result.stderr, /1 packages \(golang=1\)/);
});

test('the CLI rejects missing options and unknown purl types', () => {
  assert.equal(runCli(['--manifest', 'm', '--correlator', 'c']).status, 2);
  assert.equal(
    runCli(['--sbom', 'x', '--manifest', 'm', '--correlator', 'c', '--types', 'deb']).status,
    2
  );
});

test('the CLI fails when the SBOM holds nothing to submit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-snapshot-'));
  const sbom = join(dir, 'sbom.json');
  writeFileSync(sbom, JSON.stringify({ components: [{ purl: 'pkg:deb/debian/apt@3.0.3' }] }));
  const result = runCli(['--sbom', sbom, '--manifest', 'm', '--correlator', 'c'], {
    GITHUB_SHA: sha,
    GITHUB_REF: 'refs/heads/main',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no submittable component/);
});

// Nothing that runs the tests executes a GitHub runner, so the wiring is pinned
// here instead.
function readWorkflow(name) {
  return load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
}

function runOf(job, pattern) {
  const step = job.steps.find(candidate => pattern.test(candidate.run ?? ''));
  assert.ok(step, `a step must match ${pattern}`);
  return step.run;
}

test('the KiloClaw image is built, scanned and submitted from main', () => {
  const workflow = readWorkflow('dependency-submission.yml');
  const job = workflow.jobs['kiloclaw-image'];
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(job.permissions.contents, 'write');
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.ok(workflow.on.push.paths.includes('services/kiloclaw/Dockerfile'));
  assert.ok(workflow.on.schedule.length > 0, 'a weekly run refreshes floating dependencies');

  const build = job.steps.find(step =>
    (step.uses ?? '').startsWith('useblacksmith/build-push-action')
  );
  assert.equal(build.with.file, 'services/kiloclaw/Dockerfile');
  assert.equal(build.with.push, false);
  assert.equal(build.with.load, true);

  const scan = job.steps.find(step => (step.uses ?? '').startsWith('anchore/sbom-action@'));
  assert.equal(scan.with.image, `docker:${build.with.tags}`);
  assert.equal(scan.with.format, 'cyclonedx-json');

  const snapshot = runOf(job, /dependency-snapshot\.mjs/);
  assert.match(snapshot, /--manifest services\/kiloclaw\/Dockerfile/);
  assert.doesNotMatch(snapshot, /--types/, 'every advisory ecosystem in the image is submitted');
  assert.match(runOf(job, /dependency-graph\/snapshots/), /--method POST/);
});

test('the kilo-app release submits the Maven libraries of the shipped AAB', () => {
  const workflow = readWorkflow('kilo-app-release.yml');
  const job = workflow.jobs['submit-android-dependencies'];
  assert.deepEqual(job.needs, ['build-and-submit']);
  assert.equal(job.permissions.contents, 'write');

  const upload = workflow.jobs['build-and-submit'].steps.find(step => step.name === 'Upload SBOMs');
  const download = job.steps.find(step => step.name === 'Download SBOMs');
  assert.equal(download.with.name, upload.with.name);

  const snapshot = runOf(job, /dependency-snapshot\.mjs/);
  assert.match(snapshot, /kilo-app-android-\*\.cyclonedx\.json/);
  assert.match(snapshot, /--types maven/, 'npm is already covered by pnpm-lock.yaml');
  assert.match(runOf(job, /dependency-graph\/snapshots/), /--method POST/);
});
