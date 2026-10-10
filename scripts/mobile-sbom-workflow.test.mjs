import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

// Nothing that runs the tests executes a GitHub runner, so the release wiring is
// pinned here instead: this is the only thing that fails if a later edit drops
// the generator, makes it skippable, or loses the published copy.
const releasePath = '.github/workflows/kilo-app-release.yml';
const repoWideSbomPath = '.github/workflows/sbom.yml';
const gitignorePath = '.gitignore';
const jobName = 'build-and-submit';
const generatorCommand = 'scripts/mobile-sbom.mjs';
const sbomAssets = 'apps/mobile/artifacts/*.cyclonedx.json';

function readYaml(relativePath) {
  return load(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

function stepText(step) {
  return [
    step.name,
    step.run,
    step.uses,
    JSON.stringify(step.with ?? {}),
    JSON.stringify(step.env ?? {}),
  ]
    .filter(Boolean)
    .join(' ');
}

function requireStep(job, predicate, what) {
  const step = job.steps.find(predicate);
  assert.ok(step, `${jobName}: ${what} must exist`);
  return step;
}

function stepIndex(job, name) {
  const index = job.steps.findIndex(step => step.name === name);
  assert.notEqual(index, -1, `${jobName}: step ${JSON.stringify(name)} must exist`);
  return index;
}

test('every production build generates, retains and publishes a per-artifact SBOM', () => {
  const workflow = readYaml(releasePath);
  const job = workflow.jobs[jobName];
  assert.ok(job, `${jobName} job must exist`);

  // Exactly one generator, plain and unconditional: a build that cannot be
  // documented must fail the job before anything is submitted.
  const generators = job.steps.filter(step => (step.run ?? '').includes(generatorCommand));
  assert.equal(generators.length, 1, `exactly one step must run ${generatorCommand}`);
  const generator = generators[0];
  assert.equal(generator.if, undefined, 'the generator must not be conditional');
  assert.equal(generator['continue-on-error'], undefined, 'the generator must fail the job');
  assert.equal(generator.env, undefined, 'the generator must not receive deploy secrets');
  assert.equal(generator['working-directory'], 'apps/mobile', 'the generator runs in apps/mobile');
  for (const argument of [
    '--ipa artifacts/app.ipa',
    '--aab artifacts/app.aab',
    '--build-json build.json',
    '--podfile-lock artifacts/Podfile.lock',
    '--out-dir artifacts',
  ]) {
    assert.ok((generator.run ?? '').includes(argument), `the generator must pass ${argument}`);
  }

  const generatorIndex = job.steps.indexOf(generator);
  assert.ok(
    generatorIndex > stepIndex(job, 'Inspect artifacts'),
    'the generator must run after Inspect artifacts'
  );
  assert.ok(
    generatorIndex < stepIndex(job, 'Submit iOS'),
    'the generator must run before the first submission'
  );

  // The retained second copy, keyed by the commit like sbom.yml's cloud-sbom-<sha>.
  const upload = requireStep(
    job,
    step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'),
    'an actions/upload-artifact step'
  );
  assert.match(
    String(upload.with?.name ?? ''),
    /^mobile-sbom-/,
    'the retained artifact is keyed on the sha'
  );
  assert.equal(upload.with?.path, sbomAssets, 'the retained copy is the CycloneDX documents');
  assert.equal(upload.with?.['if-no-files-found'], 'error', 'a missing SBOM must fail the job');
  assert.equal(upload.with?.['retention-days'], 90, 'the retained copy lives 90 days');

  // The release attaches the SBOMs to the tag this job created.
  const release = requireStep(
    job,
    step => (step.run ?? '').includes('gh release create'),
    'a gh release create step'
  );
  assert.equal(
    release,
    job.steps[job.steps.length - 1],
    'the release must be the last step of the job'
  );
  assert.ok(
    (release.run ?? '').includes('RELEASE_TAG'),
    'the release must use the tag created in this job'
  );
  assert.ok(
    (release.run ?? '').includes(sbomAssets),
    'the release must upload the CycloneDX documents'
  );
  assert.ok(
    (release.run ?? '').includes('artifactSha256'),
    'the release notes must carry the SHA-256'
  );
  assert.ok((release.run ?? '').includes('EAS builds'), 'the title must name the EAS builds');
  assert.ok((release.run ?? '').includes('IOS_BUILD_ID'), 'the title must name the iOS EAS build');
  assert.ok(
    (release.run ?? '').includes('ANDROID_BUILD_ID'),
    'the title must name the Android EAS build'
  );
  assert.equal(release.env?.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}', 'gh needs a token');

  const tagRelease = requireStep(job, step => step.name === 'Tag release', 'the Tag release step');
  assert.ok(
    (tagRelease.run ?? '').includes('RELEASE_TAG=$TAG'),
    'Tag release must export the tag name'
  );
  assert.ok((tagRelease.run ?? '').includes('GITHUB_ENV'), 'the tag must reach later steps');

  // No deploy secret, authorization header or artifact URL in the SBOM steps.
  for (const step of [generator, upload, release, tagRelease]) {
    const text = stepText(step);
    assert.doesNotMatch(text, /EXPO_TOKEN/, `${step.name}: must not carry EXPO_TOKEN`);
    assert.doesNotMatch(
      text,
      /Authorization/,
      `${step.name}: must not write an Authorization header`
    );
    // Tag release names the github.com git config key for its push token.
    assert.doesNotMatch(
      text,
      /https?:\/\/(?!github\.com\/)/,
      `${step.name}: must not embed an artifact URL`
    );
  }
});

test('the SBOM release path is idempotent so a failed publication can be retried', () => {
  const workflow = readYaml(releasePath);
  const job = workflow.jobs[jobName];

  // The tag name is deterministic, so a rerun of the same commit recomputes the
  // tag the failed attempt pushed. The tag step must reuse it, or the rerun
  // dies before it can publish the missing assets.
  const tagRelease = requireStep(job, step => step.name === 'Tag release', 'the Tag release step');
  assert.ok(
    (tagRelease.run ?? '').includes('ls-remote --exit-code --tags'),
    'Tag release must reuse a tag the failed attempt already pushed'
  );

  // A rerun must reach the release the failed attempt created and republish the
  // assets instead of failing on the existing release.
  const release = requireStep(
    job,
    step => (step.run ?? '').includes('gh release create'),
    'a gh release create step'
  );
  assert.ok(
    (release.run ?? '').includes('gh release view'),
    'the release step must detect an existing release'
  );
  assert.ok(
    (release.run ?? '').includes('gh release edit'),
    'an existing release must have its metadata refreshed'
  );
  assert.ok(
    (release.run ?? '').includes('gh release upload'),
    'an existing release must receive the assets'
  );
  assert.ok(
    (release.run ?? '').includes('--clobber'),
    'republishing the assets must overwrite the previous upload'
  );
});

test('a generated SBOM and the downloaded artifacts cannot be committed', () => {
  const lines = readFileSync(new URL(`../${gitignorePath}`, import.meta.url), 'utf8').split('\n');
  assert.ok(
    lines.includes('/apps/mobile/artifacts/'),
    '.gitignore must ignore the release artifacts directory'
  );
  assert.ok(lines.includes('*.cyclonedx.json'), '.gitignore must ignore CycloneDX documents');
});

test('the repo-wide pnpm SBOM stays a separate family', () => {
  const workflow = readYaml(repoWideSbomPath);
  const texts = Object.values(workflow.jobs).flatMap(job => (job.steps ?? []).map(stepText));
  assert.ok(
    texts.some(text => text.includes('cloud-sbom-')),
    'sbom.yml must keep uploading cloud-sbom-<sha>'
  );
  assert.ok(
    texts.every(text => !text.includes(generatorCommand)),
    'sbom.yml must not fold in the per-artifact generator'
  );
});
