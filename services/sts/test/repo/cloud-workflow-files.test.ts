import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOUD_WORKFLOW_FILES } from '../worker/cloud-workflow-files';
import { repoRoot } from './repo';

describe('cloud workflow files', () => {
  it('lists every workflow file of this repository, so each is presented to the cloud CI policies', () => {
    const files = readdirSync(join(repoRoot, '.github/workflows'))
      .filter(file => /\.ya?ml$/.test(file))
      .sort();
    expect([...CLOUD_WORKFLOW_FILES].sort()).toEqual(files);
  });
});
