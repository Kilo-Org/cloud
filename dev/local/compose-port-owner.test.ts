import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeForeignPortOwners,
  foreignPortOwners,
  parsePortOwners,
} from './compose-port-owner';

const DOCKER_PS = [
  'kilo-dev-session-agent-2500\tkilo-dev-session-agent-2500-postgres-1\t0.0.0.0:7932->5432/tcp, [::]:7932->5432/tcp',
  'kilo-dev-sticky-slider-2500\tkilo-dev-sticky-slider-2500-redis-1\t0.0.0.0:8879->6379/tcp',
  '\tstandalone-container\t0.0.0.0:9000->9000/tcp',
  'kilo-dev-other-0\tno-published-ports\t5432/tcp',
  'malformed line without tabs',
].join('\n');

test('parsePortOwners reads published host ports once per container', () => {
  assert.deepEqual(parsePortOwners(DOCKER_PS), [
    {
      port: 7932,
      project: 'kilo-dev-session-agent-2500',
      container: 'kilo-dev-session-agent-2500-postgres-1',
    },
    {
      port: 8879,
      project: 'kilo-dev-sticky-slider-2500',
      container: 'kilo-dev-sticky-slider-2500-redis-1',
    },
    { port: 9000, project: '(no project)', container: 'standalone-container' },
  ]);
});

test('foreignPortOwners reports only ports held by another compose project', () => {
  const owners = parsePortOwners(DOCKER_PS);

  assert.deepEqual(
    foreignPortOwners([7932, 8879], 'kilo-dev-sticky-slider-2500', owners).map(o => o.port),
    [7932]
  );
  assert.deepEqual(foreignPortOwners([5432], 'kilo-dev-sticky-slider-2500', owners), []);
});

test('describeForeignPortOwners names the owner and the way out', () => {
  const [message] = describeForeignPortOwners(
    foreignPortOwners([7932], 'kilo-dev-sticky-slider-2500', parsePortOwners(DOCKER_PS))
  );

  assert.match(message, /port 7932 is held by container kilo-dev-session-agent-2500-postgres-1/);
  assert.match(message, /docker compose -p kilo-dev-session-agent-2500 down/);
});
