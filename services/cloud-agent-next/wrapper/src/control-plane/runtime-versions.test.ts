import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKiloCliVersion } from './runtime-versions.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

describe('runtime version probe', () => {
  it.each([
    ['7.8.17', '7.8.17'],
    ['7.9.0-canary.123', '7.9.0-canary.123'],
    ['kilo2 v0.0.0-v2-25', '0.0.0-v2-25'],
  ])(
    'reads %s from the selected executable rather than the Worker pin',
    async (output, version) => {
      const directory = await mkdtemp(join(tmpdir(), 'runtime-version-'));
      directories.push(directory);
      const cli = join(directory, 'kilo');
      await writeFile(cli, `#!/bin/sh\n[ "$1" = '--version' ] || exit 1\nprintf '${output}\\n'\n`);
      await chmod(cli, 0o755);
      expect(await readKiloCliVersion(cli)).toBe(version);
    }
  );

  it('returns unknown when the executable is missing', async () => {
    expect(await readKiloCliVersion('/missing/kilo')).toBeNull();
  });

  it('bounds a hung version probe without failing wrapper startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-version-'));
    directories.push(directory);
    const cli = join(directory, 'kilo');
    await writeFile(cli, '#!/bin/sh\nwhile :; do :; done\n');
    await chmod(cli, 0o755);
    expect(await readKiloCliVersion(cli)).toBeNull();
  }, 10_000);

  it.each([
    'not-a-version',
    '7.8.17\nprivate-value',
    'kilo2 v0.0.0-v2-25\nprivate-value',
    'kilo2 v0.0.0-v2-private-value',
  ])('rejects unexpected executable output %j', async output => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-version-'));
    directories.push(directory);
    const cli = join(directory, 'kilo');
    await writeFile(cli, `#!/bin/sh\nprintf '${output}\\n'\n`);
    await chmod(cli, 0o755);
    expect(await readKiloCliVersion(cli)).toBeNull();
  });
});
