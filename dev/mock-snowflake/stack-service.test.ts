import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { wireEnvLocalFixture } from './stack-service-fixture';

const SECTION_START = '# wired by dev/mock-snowflake/stack-service.ts';
const SECTION_END = '# end of dev/mock-snowflake wiring';
const CA_SOURCE_PREFIX = '# mock-snowflake CA: ';

function countKeyLines(content: string, key: string): number {
  return content.split('\n').filter(line => line.startsWith(`${key}=`)).length;
}

function managedSection(content: string): string {
  return content.slice(content.indexOf(SECTION_START), content.indexOf(SECTION_END));
}

/**
 * The value `scripts/dev.sh` hands Node: its `read_env_value` runs
 * `awk -F= '$1 == key'` and takes the first line where the text before the
 * first `=` is exactly the key, so `export KEY=...` and `KEY = ...` never match
 * and only one line per file is read.
 */
function firstValueDevScriptReads(
  content: string,
  key = 'NODE_EXTRA_CA_CERTS'
): string | undefined {
  for (const line of content.split('\n')) {
    if (line.split('=')[0] !== key) continue;
    return line
      .slice(key.length + 1)
      .replace(/^["']|["']$/g, '')
      .trim();
  }
  return undefined;
}

test('the first wire inserts one managed section holding the block and the CA bundle', async () => {
  const fixture = wireEnvLocalFixture('NEXTAUTH_SECRET=dev\n');
  try {
    assert.deepEqual(await fixture.wire(), { status: 'inserted' });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(content.startsWith('NEXTAUTH_SECRET=dev\n'));
    assert.match(content, /^SNOWFLAKE_ACCOUNT_HOST=127\.0\.0\.1:\d+$/m);
    assert.equal(countKeyLines(content, 'SNOWFLAKE_ACCOUNT_HOST'), 1);
    assert.equal(countKeyLines(content, 'NODE_EXTRA_CA_CERTS'), 1);
    assert.ok(content.includes(`NODE_EXTRA_CA_CERTS=${fixture.caBundlePath}`));
    assert.equal(content.split(SECTION_START).length - 1, 1);
    assert.equal(content.split(SECTION_END).length - 1, 1);

    assert.deepEqual(await fixture.wire(), { status: 'unchanged' });
    assert.equal(fs.readFileSync(fixture.envLocalPath, 'utf8'), content);
  } finally {
    fixture.restore();
  }
});

test('a wire on a new port rewrites that one section instead of keeping the old port', async () => {
  const fixture = wireEnvLocalFixture('NEXTAUTH_SECRET=dev\n');
  process.env.MOCK_SNOWFLAKE_PORT = '4792';
  try {
    await fixture.wire();

    process.env.MOCK_SNOWFLAKE_PORT = '5492';
    assert.deepEqual(await fixture.wire(), {
      status: 'rewritten',
      previousAccountHost: '127.0.0.1:4792',
      accountHost: '127.0.0.1:5492',
    });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.equal(countKeyLines(content, 'SNOWFLAKE_ACCOUNT_HOST'), 1);
    assert.match(content, /^SNOWFLAKE_ACCOUNT_HOST=127\.0\.0\.1:5492$/m);
    assert.equal(content.split(SECTION_START).length - 1, 1);
    assert.equal(content.split(SECTION_END).length - 1, 1);
  } finally {
    delete process.env.MOCK_SNOWFLAKE_PORT;
    fixture.restore();
  }
});

test('a section written before the end marker existed is rewritten in place', async () => {
  const legacy = [
    'NEXTAUTH_SECRET=dev',
    '',
    SECTION_START,
    'SNOWFLAKE_ACCOUNT_HOST=127.0.0.1:4792',
    'SNOWFLAKE_USERNAME=local',
    'NODE_EXTRA_CA_CERTS=/old/cert.pem',
    '',
  ].join('\n');
  const fixture = wireEnvLocalFixture(legacy);
  process.env.MOCK_SNOWFLAKE_PORT = '5492';
  try {
    assert.deepEqual(await fixture.wire(), {
      status: 'rewritten',
      previousAccountHost: '127.0.0.1:4792',
      accountHost: '127.0.0.1:5492',
    });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(content.startsWith('NEXTAUTH_SECRET=dev\n\n'));
    assert.equal(content.split(SECTION_START).length - 1, 1);
    assert.equal(content.split(SECTION_END).length - 1, 1);
    assert.equal(countKeyLines(content, 'SNOWFLAKE_ACCOUNT_HOST'), 1);
    assert.equal(countKeyLines(content, 'NODE_EXTRA_CA_CERTS'), 1);
  } finally {
    delete process.env.MOCK_SNOWFLAKE_PORT;
    fixture.restore();
  }
});

test('the env writer writes the offset port the service listens on', async () => {
  const fixture = wireEnvLocalFixture(undefined);
  try {
    const port = 4792 + 700;
    process.env.MOCK_SNOWFLAKE_PORT = String(port);
    try {
      await fixture.wire();
      const written = fs.readFileSync(fixture.envLocalPath, 'utf8');
      assert.match(written, new RegExp(`^SNOWFLAKE_ACCOUNT_HOST=127\\.0\\.0\\.1:${port}$`, 'm'));
    } finally {
      delete process.env.MOCK_SNOWFLAKE_PORT;
    }
  } finally {
    fixture.restore();
  }
});

test('the CA line the env writer adds is an absolute path to the bundle', async () => {
  const fixture = wireEnvLocalFixture('OTHER=1\n');
  try {
    await fixture.wire();
    const line = fs
      .readFileSync(fixture.envLocalPath, 'utf8')
      .split('\n')
      .find(candidate => candidate.startsWith('NODE_EXTRA_CA_CERTS='));
    assert.ok(line);
    const value = line.slice('NODE_EXTRA_CA_CERTS='.length);
    assert.equal(path.isAbsolute(value), true);
    assert.equal(value, fixture.caBundlePath);
  } finally {
    fixture.restore();
  }
});

for (const [spelling, envLocal] of [
  ['a plain line', 'SNOWFLAKE_ACCOUNT_HOST=real.example:443\nSNOWFLAKE_USERNAME=fred\n'],
  ['a spaced, quoted, commented line', 'SNOWFLAKE_ACCOUNT_HOST = "real.example:443"  # prod\n'],
  ['an exported line', 'export SNOWFLAKE_ACCOUNT_HOST=real.example:443\n'],
] as const) {
  test(`an existing real SNOWFLAKE_ACCOUNT_HOST (${spelling}) is never replaced`, async () => {
    const fixture = wireEnvLocalFixture(envLocal);
    try {
      assert.deepEqual(await fixture.wire(), {
        status: 'keptRealWarehouse',
        removedSection: false,
      });
      assert.equal(fs.readFileSync(fixture.envLocalPath, 'utf8'), envLocal);
    } finally {
      fixture.restore();
    }
  });
}

for (const [spelling, envLocal] of [
  ['a bare empty value', 'SNOWFLAKE_ACCOUNT_HOST=\n'],
  ['an empty quoted value', 'SNOWFLAKE_ACCOUNT_HOST=""\n'],
  ['an empty exported value', 'export SNOWFLAKE_ACCOUNT_HOST=\n'],
] as const) {
  test(`an empty SNOWFLAKE_ACCOUNT_HOST (${spelling}) is no real warehouse`, async () => {
    // The app treats an empty host as missing (`getMissingSnowflakeEnvKeys`
    // filters on falsy), and the mock is the stand-in for exactly that state:
    // wiring proceeds so the section gives the app a working warehouse.
    const fixture = wireEnvLocalFixture(envLocal);
    try {
      assert.deepEqual(await fixture.wire(), { status: 'inserted' });

      const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
      assert.ok(content.startsWith(envLocal));
      // The developer's line keeps its position above the section, so dotenv's
      // last definition still picks the section's own host up.
      assert.ok(content.indexOf('SNOWFLAKE_ACCOUNT_HOST') < content.indexOf(SECTION_START));
      assert.equal(
        content.split('\n').filter(line => line.includes('SNOWFLAKE_ACCOUNT_HOST')).length,
        2
      );
      assert.match(content, /^SNOWFLAKE_ACCOUNT_HOST=127\.0\.0\.1:\d+$/m);
    } finally {
      fixture.restore();
    }
  });
}

test('an empty SNOWFLAKE_ACCOUNT_HOST above an existing section is rewired', async () => {
  const fixture = wireEnvLocalFixture(undefined);
  try {
    // A section the stack wrote earlier, and a placeholder the developer wrote
    // while unsetting the mock above it. The line stays the file's own: the
    // section remains owned and is kept current, not removed.
    fs.writeFileSync(fixture.envLocalPath, 'SNOWFLAKE_ACCOUNT_HOST=""\n');
    assert.deepEqual(await fixture.wire(), { status: 'inserted' });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(content.startsWith('SNOWFLAKE_ACCOUNT_HOST=""\n'));
    assert.ok(content.includes(SECTION_START));
    // The developer's placeholder above the section, and the section's own
    // definition below it: two distinct lines with the same key.
    assert.match(content, /^SNOWFLAKE_ACCOUNT_HOST=""$/m);
    assert.match(content, /^SNOWFLAKE_ACCOUNT_HOST=127\.0\.0\.1:\d+$/m);
  } finally {
    fixture.restore();
  }
});

test('the last host definition outside the section decides, both orders', async () => {
  const fixture = wireEnvLocalFixture(undefined);
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    // dotenv keeps the last definition of a duplicated key. A real host above
    // an emptied placeholder is unset for the app: wiring proceeds, the
    // section is not removed.
    fs.writeFileSync(
      fixture.envLocalPath,
      'SNOWFLAKE_ACCOUNT_HOST=real.example:443\nSNOWFLAKE_ACCOUNT_HOST=\n'
    );
    assert.deepEqual(await fixture.wire(), { status: 'inserted' });
    let content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(content.includes(SECTION_START));
    assert.match(content, /^SNOWFLAKE_ACCOUNT_HOST=127\.0\.0\.1:\d+$/m);

    // The reversed order: the placeholder comes first and the real host keeps
    // it after — the last definition is the app's warehouse. The wire inserts
    // its section below the last definition (dotenv keeps the last, so the
    // section's entry must not shadow it), and the guard still sees the real
    // host outside the section on later wires: the file keeps the real host
    // and the section, because `wireEnvLocal` re-inserts under it every time.
    fixture.restore();
    const second = wireEnvLocalFixture(undefined);
    try {
      fs.writeFileSync(second.envLocalPath, 'SNOWFLAKE_ACCOUNT_HOST=real.example:443\n');
      await second.wire();
      const existing = fs.readFileSync(second.envLocalPath, 'utf8');
      fs.writeFileSync(
        second.envLocalPath,
        `SNOWFLAKE_ACCOUNT_HOST=\n${existing}SNOWFLAKE_ACCOUNT_HOST=real.example:443\n`
      );
      assert.deepEqual(await second.wire(), {
        status: 'keptRealWarehouse',
        removedSection: true,
      });
      const content = fs.readFileSync(second.envLocalPath, 'utf8');
      assert.equal(content.includes(SECTION_START), false);
      assert.match(content, /SNOWFLAKE_ACCOUNT_HOST=real\.example:443/);
    } finally {
      second.restore();
    }

    // A commented value (`KEY= # comment`) strips to empty: the same
    // unset-after-real case.
    fixture.restore();
    const third = wireEnvLocalFixture(undefined);
    try {
      fs.writeFileSync(
        third.envLocalPath,
        'SNOWFLAKE_ACCOUNT_HOST=real.example:443\nSNOWFLAKE_ACCOUNT_HOST= # unset\n'
      );
      assert.deepEqual(await third.wire(), { status: 'inserted' });
      content = fs.readFileSync(third.envLocalPath, 'utf8');
      assert.ok(content.includes(SECTION_START));
    } finally {
      third.restore();
    }
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('the bundle carries the mock certificate and a CA the file already trusted', async () => {
  const fixture = wireEnvLocalFixture(undefined);
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    const foreignCaPath = path.join(fixture.root, 'foreign-ca.pem');
    fs.writeFileSync(foreignCaPath, 'FOREIGN CA\n');
    fs.writeFileSync(fixture.envLocalPath, `NODE_EXTRA_CA_CERTS=${foreignCaPath}\n`);

    assert.deepEqual(await fixture.wire(), { status: 'inserted' });

    // `CERT` is the fixture's stand-in for the mock's own certificate.
    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nFOREIGN CA\n');

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    // The developer's own line keeps its position but names the bundle, because
    // it is the first line `scripts/dev.sh` reads and the bundle holds its bytes.
    assert.equal(firstValueDevScriptReads(content), fixture.caBundlePath);
    assert.ok(content.includes(`${CA_SOURCE_PREFIX}${foreignCaPath}`));
    assert.equal(countKeyLines(content, 'NODE_EXTRA_CA_CERTS'), 2);
    assert.equal(countKeyLines(managedSection(content), 'NODE_EXTRA_CA_CERTS'), 1);
    assert.ok(managedSection(content).includes(`NODE_EXTRA_CA_CERTS=${fixture.caBundlePath}`));

    assert.deepEqual(await fixture.wire(), { status: 'unchanged' });
    assert.equal(fs.readFileSync(fixture.envLocalPath, 'utf8'), content);
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

/** Writes one env file under the fixture's repository root. */
function writeEnvFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

for (const envFile of [
  'apps/web/.env.development.local',
  'apps/web/.env.local',
  '.env.development.local',
] as const) {
  test(`a CA named only in ${envFile} still reaches the bundle`, async () => {
    const fixture = wireEnvLocalFixture('OTHER=1\n');
    const ambient = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;
    try {
      const earlierCaPath = path.join(fixture.root, 'earlier-ca.pem');
      fs.writeFileSync(earlierCaPath, 'EARLIER CA\n');
      const envLocal = `NODE_EXTRA_CA_CERTS=${earlierCaPath}\n`;
      const envFilePath = writeEnvFile(fixture.root, envFile, envLocal);

      await fixture.wire();

      // `scripts/dev.sh` reads this file before the repo-root `.env.local`, and
      // the entry writes no file it does not own: the bundle carrying the CA is
      // what keeps the stack's `next dev` trusting it beside the mock.
      assert.equal(fs.readFileSync(envFilePath, 'utf8'), envLocal);
      assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nEARLIER CA\n');
      assert.deepEqual(await fixture.wire(), { status: 'unchanged' });
      assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nEARLIER CA\n');
    } finally {
      if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = ambient;
      fixture.restore();
    }
  });
}

test('a symlinked apps/web/.env.local contributes its CA to the bundle once', async () => {
  const fixture = wireEnvLocalFixture(undefined);
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    const caPath = path.join(fixture.root, 'symlinked-ca.pem');
    fs.writeFileSync(caPath, 'SYMLINKED CA\n');
    fs.writeFileSync(fixture.envLocalPath, `NODE_EXTRA_CA_CERTS=${caPath}\n`);
    // `scripts/dev.sh` symlinks the repo-root files into `apps/web`, so both
    // names the entry reads reach one CA and its bytes belong in the bundle once.
    fs.mkdirSync(path.join(fixture.root, 'apps', 'web'), { recursive: true });
    fs.symlinkSync(fixture.envLocalPath, path.join(fixture.root, 'apps', 'web', '.env.local'));

    await fixture.wire();

    const bundle = fs.readFileSync(fixture.caBundlePath, 'utf8');
    assert.equal(bundle, 'CERT\nSYMLINKED CA\n');
    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.equal(content.split(CA_SOURCE_PREFIX).length - 1, 1);
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a CA two names point at is written to the bundle once', async () => {
  const fixture = wireEnvLocalFixture(undefined);
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    const caPath = path.join(fixture.root, 'shared-ca.pem');
    fs.writeFileSync(caPath, 'SHARED CA\n');
    const caLinkPath = path.join(fixture.root, 'shared-ca-link.pem');
    fs.symlinkSync(caPath, caLinkPath);
    // The repo-root line names the link, the earlier file the target: resolving
    // the paths alone keeps both and trusts the same bytes twice.
    fs.writeFileSync(fixture.envLocalPath, `NODE_EXTRA_CA_CERTS=${caLinkPath}\n`);
    writeEnvFile(
      fixture.root,
      'apps/web/.env.development.local',
      `NODE_EXTRA_CA_CERTS=${caPath}\n`
    );

    await fixture.wire();

    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nSHARED CA\n');
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a shell-exported CA and an earlier file CA both reach the bundle', async () => {
  const fixture = wireEnvLocalFixture('OTHER=1\n');
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  try {
    const earlierCaPath = path.join(fixture.root, 'earlier-ca.pem');
    const shellCaPath = path.join(fixture.root, 'shell-ca.pem');
    fs.writeFileSync(earlierCaPath, 'EARLIER CA\n');
    fs.writeFileSync(shellCaPath, 'SHELL CA\n');
    writeEnvFile(
      fixture.root,
      'apps/web/.env.development.local',
      `NODE_EXTRA_CA_CERTS=${earlierCaPath}\n`
    );
    process.env.NODE_EXTRA_CA_CERTS = shellCaPath;

    await fixture.wire();

    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nEARLIER CA\nSHELL CA\n');
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a CA line the developer wrote above the section is rewritten to the bundle', async () => {
  const fixture = wireEnvLocalFixture('NEXTAUTH_SECRET=dev\n');
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    const corporateCaPath = path.join(fixture.root, 'corporate-ca.pem');
    fs.writeFileSync(corporateCaPath, 'CORPORATE CA\n');
    await fixture.wire();

    // A hand-written corporate proxy CA above the managed section wins
    // `dev.sh`'s first-match read unless it names the bundle.
    const wired = fs.readFileSync(fixture.envLocalPath, 'utf8');
    fs.writeFileSync(
      fixture.envLocalPath,
      `# corporate proxy\nNODE_EXTRA_CA_CERTS=${corporateCaPath}\n${wired}`
    );

    assert.deepEqual(await fixture.wire(), {
      status: 'rewritten',
      previousAccountHost: '127.0.0.1:4792',
      accountHost: '127.0.0.1:4792',
    });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.equal(firstValueDevScriptReads(content), fixture.caBundlePath);
    // The corporate CA stays trusted through the bundle, and the section keeps
    // its path so a rotated certificate still lands in the bundle.
    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nCORPORATE CA\n');
    assert.ok(
      content.startsWith(`# corporate proxy\nNODE_EXTRA_CA_CERTS=${fixture.caBundlePath}\n`)
    );
    assert.ok(managedSection(content).includes(`${CA_SOURCE_PREFIX}${corporateCaPath}`));

    const settled = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.deepEqual(await fixture.wire(), { status: 'unchanged' });
    assert.equal(fs.readFileSync(fixture.envLocalPath, 'utf8'), settled);

    // The recorded source is live, not a frozen copy: a rotated certificate
    // reaches the bundle on the next wire without touching `.env.local`.
    fs.writeFileSync(corporateCaPath, 'ROTATED CA\n');
    assert.deepEqual(await fixture.wire(), { status: 'unchanged' });
    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nROTATED CA\n');
    assert.equal(fs.readFileSync(fixture.envLocalPath, 'utf8'), settled);
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('an empty CA placeholder above the section is filled with the bundle', async () => {
  const fixture = wireEnvLocalFixture(undefined);
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    fs.writeFileSync(fixture.envLocalPath, 'NODE_EXTRA_CA_CERTS=\nOTHER=1\n');

    await fixture.wire();

    // An empty value makes `dev.sh` fall through to the next file, so the
    // section's own line in this one would never be read.
    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.equal(firstValueDevScriptReads(content), fixture.caBundlePath);
    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\n');
    // The displacement is recorded even for an empty value — as the bare
    // prefix — so removal can put the empty line back exactly.
    assert.ok(content.includes(CA_SOURCE_PREFIX));

    // A real warehouse takes the section back out: the recorded displacement
    // is the empty value, so the placeholder line comes back empty instead of
    // keeping the bundle path while no mock is wired.
    fs.appendFileSync(fixture.envLocalPath, 'SNOWFLAKE_ACCOUNT_HOST=real.example:443\n');
    assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse', removedSection: true });
    const afterRemoval = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(afterRemoval.startsWith('NODE_EXTRA_CA_CERTS=\nOTHER=1\n'));
    assert.equal(afterRemoval.includes(fixture.caBundlePath), false);
    assert.equal(afterRemoval.includes(SECTION_START), false);
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a real warehouse keeps its own CA line and the file byte-identical', async () => {
  const envLocal = `NODE_EXTRA_CA_CERTS=/corporate/ca.pem\nSNOWFLAKE_ACCOUNT_HOST=real.example:443\n`;
  const fixture = wireEnvLocalFixture(envLocal);
  try {
    assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse', removedSection: false });
    assert.equal(fs.readFileSync(fixture.envLocalPath, 'utf8'), envLocal);
  } finally {
    fixture.restore();
  }
});

test('removal restores the value the last wire displaced, rotation included', async () => {
  const fixture = wireEnvLocalFixture('NEXTAUTH_SECRET=dev\n');
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    const caAPath = path.join(fixture.root, 'ca-a.pem');
    const caBPath = path.join(fixture.root, 'ca-b.pem');
    fs.writeFileSync(caAPath, 'CA A\n');
    fs.writeFileSync(caBPath, 'CA B\n');

    // Wire 1 displaced ca-a (the line sits above where the section goes);
    // wire 2 displaced the bundle line with ca-b; wire 3 displaced ca-b with
    // ca-a again — the section stays in place, so the third wire rewrote it
    // and mergeCaSources had to move the re-folded ca-a record to the end.
    // The newest record is exactly ca-a — the last value this line displaced —
    // not the first one it ever displaced, and not ca-b.
    fs.writeFileSync(fixture.envLocalPath, `NODE_EXTRA_CA_CERTS=${caAPath}\n`);
    await fixture.wire();
    const content1 = fs.readFileSync(fixture.envLocalPath, 'utf8');
    fs.writeFileSync(
      fixture.envLocalPath,
      `NODE_EXTRA_CA_CERTS=${caBPath}\n${content1.slice(content1.indexOf(SECTION_START))}`
    );
    await fixture.wire();
    // Wire 3: swap the line's value in place, above the section wire 2 kept.
    const content2 = fs.readFileSync(fixture.envLocalPath, 'utf8');
    fs.writeFileSync(
      fixture.envLocalPath,
      content2.replace(
        `NODE_EXTRA_CA_CERTS=${fixture.caBundlePath}`,
        `NODE_EXTRA_CA_CERTS=${caAPath}`
      )
    );
    await fixture.wire();
    assert.ok(
      fs
        .readFileSync(fixture.envLocalPath, 'utf8')
        .startsWith(`NODE_EXTRA_CA_CERTS=${fixture.caBundlePath}\n`)
    );

    // A real warehouse: the line's displaced value ca-a comes back, whatever
    // older records for the same line said.
    fs.writeFileSync(
      fixture.envLocalPath,
      `${fs.readFileSync(fixture.envLocalPath, 'utf8')}SNOWFLAKE_ACCOUNT_HOST=real.example:443\n`
    );
    assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse', removedSection: true });
    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(content.startsWith(`NODE_EXTRA_CA_CERTS=${caAPath}\n`));
    assert.equal(content.includes(fixture.caBundlePath), false);
    assert.equal(content.includes(SECTION_START), false);
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a real warehouse still leaves the CA bundle behind for the prefixed command', async () => {
  const fixture = wireEnvLocalFixture(undefined);
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    const developerCaPath = path.join(fixture.root, 'developer-ca.pem');
    fs.writeFileSync(developerCaPath, 'DEVELOPER CA\n');
    fs.writeFileSync(
      fixture.envLocalPath,
      `NODE_EXTRA_CA_CERTS=${developerCaPath}\nSNOWFLAKE_ACCOUNT_HOST=real.example:443\n`
    );

    // A fresh checkout's order: the real warehouse is written first and the
    // stack has never run, so no bundle exists yet — but the nextjs command is
    // prefixed with `NODE_EXTRA_CA_CERTS=<bundle>` all the same, because the
    // core group always carries the mock.
    assert.equal(fs.existsSync(fixture.caBundlePath), false);
    assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse', removedSection: false });

    // The bundle exists and carries the CA the developer named; the file it
    // named stays untouched, so the bytes keep reaching the app either way.
    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nDEVELOPER CA\n');
    assert.equal(
      fs.readFileSync(fixture.envLocalPath, 'utf8'),
      `NODE_EXTRA_CA_CERTS=${developerCaPath}\nSNOWFLAKE_ACCOUNT_HOST=real.example:443\n`
    );
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a real warehouse folds the shell CA and earlier env-file CAs into the bundle', async () => {
  const fixture = wireEnvLocalFixture('SNOWFLAKE_ACCOUNT_HOST=real.example:443\n');
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  try {
    const shellCaPath = path.join(fixture.root, 'shell-ca.pem');
    const earlierCaPath = path.join(fixture.root, 'earlier-ca.pem');
    fs.writeFileSync(shellCaPath, 'SHELL CA\n');
    fs.writeFileSync(earlierCaPath, 'EARLIER CA\n');
    writeEnvFile(
      fixture.root,
      'apps/web/.env.development.local',
      `NODE_EXTRA_CA_CERTS=${earlierCaPath}\n`
    );
    process.env.NODE_EXTRA_CA_CERTS = shellCaPath;

    assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse', removedSection: false });

    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nEARLIER CA\nSHELL CA\n');
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a real warehouse above the section makes the entry take its section back out', async () => {
  const fixture = wireEnvLocalFixture('NEXTAUTH_SECRET=dev\n');
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    const corporateCaPath = path.join(fixture.root, 'corporate-ca.pem');
    fs.writeFileSync(corporateCaPath, 'CORPORATE CA\n');

    await fixture.wire();
    const wired = fs.readFileSync(fixture.envLocalPath, 'utf8');
    fs.writeFileSync(
      fixture.envLocalPath,
      `# corporate proxy\nNODE_EXTRA_CA_CERTS=${corporateCaPath}\n${wired}`
    );
    // The wire points that line at the bundle, because it shadows the section's,
    // and records the path it named.
    await fixture.wire();
    const repointed = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(
      repointed.startsWith(`# corporate proxy\nNODE_EXTRA_CA_CERTS=${fixture.caBundlePath}\n`)
    );
    assert.ok(repointed.includes(`${CA_SOURCE_PREFIX}${corporateCaPath}`));

    // A real warehouse now sits above our section, so `dotenv` would let the
    // section's own `SNOWFLAKE_ACCOUNT_HOST` win if it stayed.
    fs.writeFileSync(fixture.envLocalPath, `SNOWFLAKE_ACCOUNT_HOST=real.example:443\n${repointed}`);

    assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse', removedSection: true });

    // Byte for byte: the section and the blank line the insert added are gone,
    // the developer's CA line names its own file again, and the rest is untouched.
    assert.equal(
      fs.readFileSync(fixture.envLocalPath, 'utf8'),
      `SNOWFLAKE_ACCOUNT_HOST=real.example:443\n# corporate proxy\nNODE_EXTRA_CA_CERTS=${corporateCaPath}\nNEXTAUTH_SECRET=dev\n`
    );
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a CA line the developer changed since is left alone when the section goes', async () => {
  const fixture = wireEnvLocalFixture('NEXTAUTH_SECRET=dev\n');
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    const corporateCaPath = path.join(fixture.root, 'corporate-ca.pem');
    const replacementCaPath = path.join(fixture.root, 'replacement-ca.pem');
    fs.writeFileSync(corporateCaPath, 'CORPORATE CA\n');
    fs.writeFileSync(replacementCaPath, 'REPLACEMENT CA\n');
    await fixture.wire();
    fs.writeFileSync(
      fixture.envLocalPath,
      `NODE_EXTRA_CA_CERTS=${corporateCaPath}\n${fs.readFileSync(fixture.envLocalPath, 'utf8')}`
    );
    // The wire repoints that line at the bundle and records what it displaced.
    await fixture.wire();
    const repointed = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(
      repointed.startsWith(`NODE_EXTRA_CA_CERTS=${fixture.caBundlePath}\n`) &&
        repointed.includes(`${CA_SOURCE_PREFIX}${corporateCaPath}`)
    );

    // The developer points the line at another CA and switches to a real
    // warehouse. Restoring the recorded source would lose the value they chose.
    fs.writeFileSync(
      fixture.envLocalPath,
      `NODE_EXTRA_CA_CERTS=${replacementCaPath}\nSNOWFLAKE_ACCOUNT_HOST=real.example:443\n${repointed.slice(
        `NODE_EXTRA_CA_CERTS=${fixture.caBundlePath}\n`.length
      )}`
    );

    assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse', removedSection: true });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(content.startsWith(`NODE_EXTRA_CA_CERTS=${replacementCaPath}\n`));
    assert.equal(content.includes(SECTION_START), false);
    assert.equal(content.includes(SECTION_END), false);
    assert.equal(countKeyLines(content, 'SNOWFLAKE_ACCOUNT_HOST'), 1);
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

test('a legacy section leaves developer SNOWFLAKE_* tuning keys appended after it out', async () => {
  const legacy = [
    'NEXTAUTH_SECRET=dev',
    '',
    SECTION_START,
    'SNOWFLAKE_ACCOUNT_HOST=127.0.0.1:4792',
    'SNOWFLAKE_USERNAME=local',
    'NODE_EXTRA_CA_CERTS=/old/cert.pem',
    'SNOWFLAKE_LOG_LEVEL=debug',
  ].join('\n');
  const fixture = wireEnvLocalFixture(legacy);
  process.env.MOCK_SNOWFLAKE_PORT = '5492';
  try {
    // `SNOWFLAKE_LOG_LEVEL` is a key the writer never emits: a wire outside any
    // section means the run the old writer left ended before it. The line must
    // stand alone — this fixture's `snowflake-env.txt` names no real host, so a
    // rewrite keeps the file's own entries and appends the section after them.
    assert.deepEqual(await fixture.wire(), {
      status: 'rewritten',
      previousAccountHost: '127.0.0.1:4792',
      accountHost: '127.0.0.1:5492',
    });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(content.startsWith('NEXTAUTH_SECRET=dev\n\n'));
    // The developer's line keeps its tail position, outside the managed
    // section, and counts as the file's own host entry.
    assert.ok(content.includes('SNOWFLAKE_LOG_LEVEL=debug'));
    assert.ok(content.indexOf('SNOWFLAKE_LOG_LEVEL=debug') > content.indexOf(SECTION_END));
    assert.equal(content.split('SNOWFLAKE_LOG_LEVEL=').length - 1, 1);
    assert.equal(countKeyLines(content, 'SNOWFLAKE_LOG_LEVEL'), 1);
    // The rewrite still landed (the legacy host moved to the current port).
    assert.match(content, /^SNOWFLAKE_ACCOUNT_HOST=127\.0\.0\.1:5492$/m);
  } finally {
    delete process.env.MOCK_SNOWFLAKE_PORT;
    fixture.restore();
  }
});

test('removing the section on a real warehouse keeps developer keys it does not own', async () => {
  // The fixture's `snowflake-env.txt` is read-only here: the wire below only
  // removes the section, so it starts no mock and the port never conflicts.
  const fixture = wireEnvLocalFixture(
    [
      'NEXTAUTH_SECRET=dev',
      '',
      SECTION_START,
      'SNOWFLAKE_ACCOUNT_HOST=127.0.0.1:4792',
      'SNOWFLAKE_USERNAME=local',
      'NODE_EXTRA_CA_CERTS=/old/cert.pem',
      'SNOWFLAKE_LOG_LEVEL=debug',
      // A real warehouse the developer appended this legacy run must not
      // own: the entry takes only its own lines back out on a real host.
      'SNOWFLAKE_ACCOUNT_HOST=real.example:443',
      '',
    ].join('\n')
  );
  try {
    assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse', removedSection: true });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.equal(content.includes(SECTION_START), false);
    assert.equal(content.includes(SECTION_END), false);
    // The developer's tuning key and the real host both stay.
    assert.ok(content.includes('SNOWFLAKE_LOG_LEVEL=debug'));
    assert.equal(countKeyLines(content, 'SNOWFLAKE_ACCOUNT_HOST'), 1);
    assert.equal(
      content,
      'NEXTAUTH_SECRET=dev\nSNOWFLAKE_LOG_LEVEL=debug\nSNOWFLAKE_ACCOUNT_HOST=real.example:443\n'
    );
  } finally {
    fixture.restore();
  }
});

test('a wire replaces the section after a developer line the legacy writer left', async () => {
  const fixture = wireEnvLocalFixture(
    [
      'NEXTAUTH_SECRET=dev',
      '',
      SECTION_START,
      'SNOWFLAKE_ACCOUNT_HOST=127.0.0.1:4792',
      'SNOWFLAKE_USERNAME=local',
      'NODE_EXTRA_CA_CERTS=/old/cert.pem',
      'SNOWFLAKE_LOG_LEVEL=debug',
    ].join('\n')
  );
  try {
    // `SNOWFLAKE_LOG_LEVEL` is a key the writer never emits: the run the old
    // writer left ends there. The section for the port the mock still listens
    // on is re-emitted in place, and the developer's line stays after this
    // range — not absorbed by it.
    assert.deepEqual(await fixture.wire(), {
      status: 'rewritten',
      previousAccountHost: '127.0.0.1:4792',
      accountHost: '127.0.0.1:4792',
    });

    const content = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.ok(content.startsWith('NEXTAUTH_SECRET=dev\n\n'));
    assert.ok(content.includes('SNOWFLAKE_LOG_LEVEL=debug'));
    assert.ok(content.indexOf('SNOWFLAKE_LOG_LEVEL=debug') > content.indexOf(SECTION_END));
    assert.equal(content.split('SNOWFLAKE_LOG_LEVEL=').length - 1, 1);
    assert.equal(countKeyLines(content, 'SNOWFLAKE_LOG_LEVEL'), 1);
    // The rewrite still landed (the legacy host moved to the current port).
    assert.match(content, /^SNOWFLAKE_ACCOUNT_HOST=127\.0\.0\.1:4792$/m);

    // And the file settles: the same wire twice leaves the section identical.
    const settled = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.deepEqual(await fixture.wire(), { status: 'unchanged' });
    assert.equal(fs.readFileSync(fixture.envLocalPath, 'utf8'), settled);
  } finally {
    fixture.restore();
  }
});

for (const [separatorNote, separator] of [
  ['a heading comment', '\n# my real warehouse\n'],
  ['nothing at all', '\n'],
  // Two blanks in a row inside the legacy run: a blank carries no key, so it
  // must not end the owned range (a second blank used to trip the dedup).
  ['a second blank line', '\n\n'],
] as const) {
  test(`a legacy section keeps a real warehouse block appended after it (${separatorNote})`, async () => {
    const fixture = wireEnvLocalFixture(
      [
        'NEXTAUTH_SECRET=dev',
        '',
        SECTION_START,
        'SNOWFLAKE_ACCOUNT_HOST=127.0.0.1:4792',
        'SNOWFLAKE_USERNAME=local',
        'NODE_EXTRA_CA_CERTS=/old/cert.pem',
        `${separator}SNOWFLAKE_ACCOUNT_HOST=real.example:443`,
        'SNOWFLAKE_USERNAME=fred',
        '',
      ].join('\n')
    );
    try {
      assert.deepEqual(await fixture.wire(), {
        status: 'keptRealWarehouse',
        removedSection: true,
      });

      // The legacy block goes, the real one stays, and the file keeps the shape
      // it had around them (the separator's lines are the developer's).
      const separatorLines = separator.split('\n').filter(line => line !== '');
      assert.equal(
        fs.readFileSync(fixture.envLocalPath, 'utf8'),
        [
          'NEXTAUTH_SECRET=dev',
          ...separatorLines,
          'SNOWFLAKE_ACCOUNT_HOST=real.example:443',
          'SNOWFLAKE_USERNAME=fred',
          '',
        ].join('\n')
      );
    } finally {
      fixture.restore();
    }
  });
}

test('a shell-exported CA stays trusted through the bundle', async () => {
  const fixture = wireEnvLocalFixture('OTHER=1\n');
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  try {
    const foreignCaPath = path.join(fixture.root, 'shell-ca.pem');
    fs.writeFileSync(foreignCaPath, 'SHELL CA\n');
    process.env.NODE_EXTRA_CA_CERTS = foreignCaPath;

    await fixture.wire();
    assert.equal(fs.readFileSync(fixture.caBundlePath, 'utf8'), 'CERT\nSHELL CA\n');

    // The section names the bundle, not the shell's file, so a restart builds
    // the same bundle and leaves the file alone.
    assert.deepEqual(await fixture.wire(), { status: 'unchanged' });
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});
