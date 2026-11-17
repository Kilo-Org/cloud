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
    assert.equal(content.includes(CA_SOURCE_PREFIX), false);
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

for (const [separatorNote, separator] of [
  ['a heading comment', '\n# my real warehouse\n'],
  ['nothing at all', '\n'],
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
      // it had around them.
      assert.equal(
        fs.readFileSync(fixture.envLocalPath, 'utf8'),
        [
          'NEXTAUTH_SECRET=dev',
          ...(separator === '\n' ? [] : ['# my real warehouse']),
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
