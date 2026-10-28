import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { handleRequest, type HandlerDeps, type HandlerRequest, type LogEvent } from './handlers';
import { KmsRequestError, type KmsApi, type KmsContext } from './kms';

const TOKEN = 'test-token';
const dek = randomBytes(32);

function fakeKms(): KmsApi {
  const wrap = (context: KmsContext) => Buffer.from(JSON.stringify(context)).toString('base64');
  return {
    async generateDataKey({ context }) {
      return { plaintext: Buffer.from(dek), ciphertextBlob: wrap(context), keyId: 'arn:test' };
    },
    async decrypt({ ciphertextBlob, context }) {
      if (ciphertextBlob !== wrap(context)) throw new KmsRequestError('Decrypt', 400);
      return Buffer.from(dek);
    },
  };
}

const logs: LogEvent[] = [];

const deps: HandlerDeps = {
  kms: fakeKms(),
  kmsKeyId: 'alias/test',
  serviceToken: TOKEN,
  log: event => logs.push(event),
};

const userContext = {
  key_id: 'key-1',
  owner_type: 'user',
  owner_id: 'u1',
  provider_id: 'openai',
} as const;

const orgContext = {
  key_id: 'key-2',
  owner_type: 'organization',
  owner_id: 'org-1',
  provider_id: 'openai',
} as const;

const request = (overrides: Partial<HandlerRequest>): HandlerRequest => ({
  method: 'POST',
  path: '/data-key',
  authorization: `Bearer ${TOKEN}`,
  query: {},
  body: undefined,
  ...overrides,
});

const create = (body: unknown, authorization: string | undefined = `Bearer ${TOKEN}`) =>
  handleRequest(deps, request({ method: 'POST', body, authorization }));

const get = (
  query: Record<string, string>,
  authorization: string | undefined = `Bearer ${TOKEN}`
) => handleRequest(deps, request({ method: 'GET', query, authorization }));

type Created = {
  data_key: string;
  wrapped_dek: string;
  kms_key_id: string;
  kms_key_version: string;
};

const fakeCreated: Created = {
  data_key: '',
  wrapped_dek: 'wrapped',
  kms_key_id: 'arn:test',
  kms_key_version: '1',
};

const getQuery = (context: Record<string, string>, created: Created) => ({
  ...context,
  wrapped_dek: created.wrapped_dek,
  kms_key_id: created.kms_key_id,
  kms_key_version: created.kms_key_version,
});

test('POST returns a data key and its wrapped form, and GET returns the same data key', async () => {
  const created = await create({ ...userContext, actor_user_id: 'u1' });
  assert.equal(created.status, 200);
  const body = created.body as Created;
  assert.equal(body.data_key, dek.toString('base64'));
  assert.equal(body.kms_key_id, 'arn:test');
  assert.equal(body.kms_key_version, '1');

  const fetched = await get(getQuery(userContext, body));
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body, { data_key: body.data_key });
});

test('GET rejects any identifier that differs from creation time', async () => {
  const body = (await create(orgContext)).body as Created;

  for (const spoofed of [
    { owner_id: 'org-2' },
    { owner_type: 'user' },
    { key_id: 'key-3' },
    { provider_id: 'anthropic' },
  ]) {
    const result = await get(getQuery({ ...orgContext, ...spoofed }, body));
    assert.equal(result.status, 403, JSON.stringify(spoofed));
  }
});

test('GET reports 502 when KMS itself fails', async () => {
  const failing: HandlerDeps = {
    ...deps,
    kms: {
      ...fakeKms(),
      decrypt: async () => {
        throw new KmsRequestError('Decrypt', 503);
      },
    },
  };
  const result = await handleRequest(
    failing,
    request({ method: 'GET', query: getQuery(userContext, fakeCreated) })
  );
  assert.equal(result.status, 502);
});

test('rejects requests missing key id or owner context', async () => {
  const { key_id: _keyId, ...withoutKeyId } = userContext;
  const { owner_id: _ownerId, ...withoutOwnerId } = userContext;
  assert.equal((await create(withoutKeyId)).status, 400);
  assert.equal((await create(withoutOwnerId)).status, 400);
  assert.equal((await get({ ...userContext })).status, 400);
});

test('logs KMS-verified identifiers on GET and unverified claims otherwise', async () => {
  logs.length = 0;
  const body = (await create({ ...orgContext, actor_user_id: 'u9' })).body as Created;
  await get(getQuery(orgContext, body));
  await get(getQuery({ ...orgContext, owner_id: 'org-2' }, body));
  await create({ provider_id: 'openai' });

  assert.deepEqual(
    logs.map(event => ({
      operation: event.operation,
      status: event.status,
      verified: event.identifiers_verified,
      key_id: event.key_id,
      organization_id: event.organization_id,
      user_id: event.user_id,
      actor_user_id: event.actor_user_id,
    })),
    [
      {
        operation: 'create',
        status: 200,
        verified: false,
        key_id: 'key-2',
        organization_id: 'org-1',
        user_id: undefined,
        actor_user_id: 'u9',
      },
      {
        operation: 'get',
        status: 200,
        verified: true,
        key_id: 'key-2',
        organization_id: 'org-1',
        user_id: undefined,
        actor_user_id: undefined,
      },
      {
        operation: 'get',
        status: 403,
        verified: false,
        key_id: 'key-2',
        organization_id: 'org-2',
        user_id: undefined,
        actor_user_id: undefined,
      },
      {
        operation: 'create',
        status: 400,
        verified: false,
        key_id: undefined,
        organization_id: undefined,
        user_id: undefined,
        actor_user_id: undefined,
      },
    ]
  );
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(body.data_key));
  assert.ok(!serialized.includes(body.wrapped_dek));
});

test('user keys log the owner as user_id and never as organization_id', async () => {
  logs.length = 0;
  await create(userContext);
  assert.equal(logs[0].user_id, 'u1');
  assert.equal(logs[0].organization_id, undefined);
});

test('rejects missing or wrong bearer token', async () => {
  assert.equal((await create(userContext, '')).status, 401);
  assert.equal((await get({}, 'Bearer nope')).status, 401);
});

test('rejects unknown routes and methods', async () => {
  assert.equal((await handleRequest(deps, request({ path: '/encrypt' }))).status, 404);
  assert.equal((await handleRequest(deps, request({ path: '/decrypt' }))).status, 404);
  assert.equal((await handleRequest(deps, request({ method: 'DELETE' }))).status, 405);
});
