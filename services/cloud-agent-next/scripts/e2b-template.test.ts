import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { Template } from 'e2b';
import { describe, expect, it } from 'vitest';
import { createE2BReleaseManifest, createE2BRuntimeManifest } from './e2b-template.js';

const bytes = new TextEncoder();
const files = {
  'control-wrapper.js': bytes.encode('control-wrapper'),
  'restore-session.js': bytes.encode('restore-session'),
  bb: bytes.encode('bb-cli'),
  'kilo-git-credential': bytes.encode('git-credential'),
  Dockerfile: bytes.encode('template-image'),
};

describe('E2B runtime release identity', () => {
  it('changes the immutable runtime identity when any packaged artifact changes', () => {
    const first = createE2BRuntimeManifest(files);
    expect(createE2BRuntimeManifest(files)).toEqual(first);
    for (const name of Object.keys(files)) {
      const changed = createE2BRuntimeManifest({
        ...files,
        [name]: bytes.encode(`changed-${name}`),
      });
      expect(changed.runtimeBuildId).not.toBe(first.runtimeBuildId);
    }
  });

  it('pins a build UUID, strips provider payload extras and never implies live qualification', () => {
    const manifest = createE2BRuntimeManifest(files);
    const release = createE2BReleaseManifest(manifest, 'kilo-test', {
      templateId: 'test-template',
      buildId: '11111111-1111-4111-8111-111111111111',
      apiKey: 'must-not-be-published',
    });
    expect(release.templateReference).toBe(
      'kilo-test/kilo-cloud-agent:11111111-1111-4111-8111-111111111111'
    );
    expect(release.qualification).toBe('requires-cross-project-live-smoke');
    expect(JSON.stringify(release)).not.toContain('must-not-be-published');
    expect(release.public).toBe(false);
  });

  it.each(['default', 'production', '', 'not-a-build'])(
    'rejects mutable or invalid build %s',
    buildId => {
      expect(() =>
        createE2BReleaseManifest(createE2BRuntimeManifest(files), 'kilo-test', {
          templateId: 'test-template',
          buildId,
        })
      ).toThrow();
    }
  );

  it('accepts the dedicated AMD64 template definition without performing a remote build', () => {
    const path = fileURLToPath(new URL('../e2b/Dockerfile', import.meta.url));
    expect(() => Template().fromDockerfile(readFileSync(path, 'utf8'))).not.toThrow();
  });
});
