import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { wireEnvLocalFixture } from './stack-service-fixture';

const SECTION_START = '# wired by dev/mock-snowflake/stack-service.ts';
const SECTION_END = '# end of dev/mock-snowflake wiring';

function countKeyLines(content: string, key: string): number {
  return content.split('\n').filter(line => line.startsWith(`${key}=`)).length;
}

function managedSection(content: string): string {
  return content.slice(content.indexOf(SECTION_START), content.indexOf(SECTION_END));
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
      assert.deepEqual(await fixture.wire(), { status: 'keptRealWarehouse' });
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
    // The developer's own line stays where it was; the managed section adds its
    // own single line, naming the bundle.
    assert.equal(countKeyLines(content, 'NODE_EXTRA_CA_CERTS'), 2);
    assert.equal(countKeyLines(managedSection(content), 'NODE_EXTRA_CA_CERTS'), 1);
    assert.ok(managedSection(content).includes(`NODE_EXTRA_CA_CERTS=${fixture.caBundlePath}`));
  } finally {
    if (ambient === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = ambient;
    fixture.restore();
  }
});

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
