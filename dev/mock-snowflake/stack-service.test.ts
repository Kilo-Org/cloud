import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { wireEnvLocalFixture } from './stack-service-fixture';

test('the env writer appends the block, the CA line, and nothing on a second start', async () => {
  const fixture = wireEnvLocalFixture('NEXTAUTH_SECRET=dev\n');
  const SNOWFLAKE_ENV_WIRE_MARKER = 'wired by dev/mock-snowflake/stack-service.ts';
  try {
    const first = await fixture.wire();
    assert.deepEqual(first, { appended: true });
    const once = fs.readFileSync(fixture.envLocalPath, 'utf8');
    assert.match(once, /^SNOWFLAKE_ACCOUNT_HOST=127\.0\.0\.1:\d+$/m);
    assert.match(once, /^NODE_EXTRA_CA_CERTS=/m);
    assert.equal(once.match(/NODE_EXTRA_CA_CERTS=/g)?.length, 1);
    assert.match(once, new RegExp(SNOWFLAKE_ENV_WIRE_MARKER));

    const second = await fixture.wire();
    assert.deepEqual(second, { appended: false });
    assert.equal(fs.readFileSync(fixture.envLocalPath, 'utf8'), once);
  } finally {
    fixture.restore();
  }
});

test('an existing real SNOWFLAKE_ACCOUNT_HOST is never replaced', async () => {
  const fixture = wireEnvLocalFixture(
    'SNOWFLAKE_ACCOUNT_HOST=real.example:443\nSNOWFLAKE_USERNAME=fred\n'
  );
  try {
    const result = await fixture.wire();
    assert.deepEqual(result, { appended: false, keptRealWarehouse: true });
    assert.equal(
      fs.readFileSync(fixture.envLocalPath, 'utf8'),
      'SNOWFLAKE_ACCOUNT_HOST=real.example:443\nSNOWFLAKE_USERNAME=fred\n'
    );
  } finally {
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

test('the CA line the env writer adds is an absolute path to the certificate', async () => {
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
    assert.equal(value.endsWith(path.join('fixtures', 'tls', 'cert.pem')), true);
  } finally {
    fixture.restore();
  }
});
