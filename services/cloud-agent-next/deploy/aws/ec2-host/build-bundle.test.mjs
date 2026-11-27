import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { savedDockerImageId } from './build-bundle.mjs';

for (const layout of ['oci', 'classic']) {
  test(`pins the image config digest from a ${layout} Docker archive`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ec2-host-image-test-'));
    try {
      const bytes = JSON.stringify({ architecture: 'amd64', os: 'linux', config: {} });
      const digest = createHash('sha256').update(bytes).digest('hex');
      const configPath = layout === 'oci' ? `blobs/sha256/${digest}` : `${digest}.json`;
      if (layout === 'oci') mkdirSync(join(root, 'blobs/sha256'), { recursive: true });
      const manifest = { Config: configPath, RepoTags: [], Layers: [] };
      writeFileSync(join(root, configPath), bytes);
      writeFileSync(join(root, 'manifest.json'), JSON.stringify([manifest]));
      const archive = join(root, 'image.tar');
      const pack = () =>
        execFileSync('tar', ['-C', root, '-cf', archive, 'manifest.json', configPath]);
      pack();
      assert.equal(savedDockerImageId(archive), `sha256:${digest}`);

      writeFileSync(join(root, configPath), bytes + '\n');
      pack();
      assert.throws(() => savedDockerImageId(archive), /Invalid EC2 workload image configuration/);

      writeFileSync(join(root, 'manifest.json'), JSON.stringify([manifest, manifest]));
      pack();
      assert.throws(() => savedDockerImageId(archive), /Expected one EC2 workload image/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
