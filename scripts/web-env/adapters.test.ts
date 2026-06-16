import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandExecutor, CommandRequest, CommandResult } from './command.js';
import { OnePasswordAdapter } from './onepassword.js';
import { VercelAdapter } from './vercel.js';

function success(stdout: string): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

void test('Vercel adapter uses isolated project IDs and passes values only through stdin', async () => {
  const requests: CommandRequest[] = [];
  const execute: CommandExecutor = async request => {
    requests.push(request);
    const args = request.args;
    if (args.includes('--version')) return success('Vercel CLI 53.3.1');
    if (args.includes('whoami')) {
      return success(JSON.stringify({ team: { id: 'team_test', slug: 'kilocode' } }));
    }
    if (args.includes('project') && args.includes('list')) {
      const filterIndex = args.indexOf('--filter');
      const name = args[filterIndex + 1];
      return success(JSON.stringify({ projects: [{ id: `id-${name}`, name }] }));
    }
    if (args.includes('target') && args.includes('list')) {
      return success(JSON.stringify({ targets: [{ id: 'env_staging', slug: 'staging' }] }));
    }
    if (args.includes('api')) {
      return success(
        JSON.stringify({ env: { API_TOKEN: 'literal\\nsequence {"key":"value"} C:\\temp' } })
      );
    }
    if (args.includes('env') && args.includes('add')) return success('{}');
    if (args.includes('env') && args.includes('list')) {
      return success(JSON.stringify({ envs: [{ key: 'API_TOKEN', type: 'sensitive' }] }));
    }
    throw new Error(`Unexpected fake command: ${args.join(' ')}`);
  };

  const adapter = new VercelAdapter(execute, '/private/temp');
  await adapter.initialize();
  await adapter.writeVariable({
    mode: 'add',
    project: 'kilocode-app',
    environment: 'production',
    key: 'API_TOKEN',
    value: 'super-secret-value',
    sensitive: true,
    expectedType: 'sensitive',
  });
  await adapter.writeVariable({
    mode: 'add',
    project: 'kilocode-app',
    environment: 'staging',
    key: 'API_TOKEN',
    value: 'staging-secret-value',
    sensitive: true,
    expectedType: 'sensitive',
  });

  const write = requests.find(
    request => request.args.includes('add') && request.args.includes('production')
  );
  assert.ok(write);
  assert.equal(write.stdin, 'super-secret-value');
  assert.equal(write.args.includes('super-secret-value'), false);
  assert.equal(write.cwd, '/private/temp');
  assert.equal(write.env?.VERCEL_ORG_ID, 'team_test');
  assert.equal(write.env?.VERCEL_PROJECT_ID, 'id-kilocode-app');
  const stagingWrite = requests.find(
    request => request.args.includes('add') && request.args.includes('env_staging')
  );
  assert.ok(stagingWrite);
  assert.equal(stagingWrite.args.includes('staging'), false);
  assert.equal(
    await adapter.pullReadableValue('kilocode-app', 'production', 'API_TOKEN'),
    'literal\\nsequence {"key":"value"} C:\\temp'
  );
  const pull = requests.find(request =>
    request.args.includes('/v3/env/pull/id-kilocode-app/production?source=vercel-cli%3Aenv%3Apull')
  );
  assert.ok(pull);
  assert.ok(
    requests.every(request => request.cwd === undefined || request.cwd === '/private/temp')
  );
});

void test('Vercel adapter keeps sensitive development values exportable', async () => {
  const requests: CommandRequest[] = [];
  const execute: CommandExecutor = async request => {
    requests.push(request);
    if (request.args.includes('--version')) return success('53.3.1');
    if (request.args.includes('whoami')) {
      return success(JSON.stringify({ team: { id: 'team_test', slug: 'kilocode' } }));
    }
    if (request.args.includes('project')) {
      const name = request.args[request.args.indexOf('--filter') + 1];
      return success(JSON.stringify({ projects: [{ id: `id-${name}`, name }] }));
    }
    if (request.args.includes('target')) {
      return success(JSON.stringify({ targets: [{ id: 'env_staging', slug: 'staging' }] }));
    }
    if (request.args.includes('add')) return success('{}');
    if (request.args.includes('list')) {
      return success(JSON.stringify({ envs: [{ key: 'TOKEN', type: 'encrypted' }] }));
    }
    throw new Error('Unexpected fake command');
  };
  const adapter = new VercelAdapter(execute, '/private/temp');
  await adapter.initialize();
  await adapter.writeVariable({
    mode: 'add',
    project: 'kilocode-app',
    environment: 'development',
    key: 'TOKEN',
    value: 'development-secret',
    sensitive: false,
    expectedType: 'encrypted',
  });
  const write = requests.find(request => request.args.includes('add'));
  assert.ok(write?.args.includes('--no-sensitive'));
  assert.equal(write?.args.includes('--sensitive'), false);
});

void test('1Password preflight rejects duplicate or malformed existing items', async () => {
  const duplicates: CommandExecutor = async request => {
    if (request.args[0] === '--version') return success('2.32.0');
    if (request.args[0] === 'whoami') return success('{}');
    if (request.args[0] === 'vault') return success(JSON.stringify({ id: 'vault_test' }));
    if (request.args[0] === 'item' && request.args[1] === 'list') {
      return success(
        JSON.stringify([
          { id: 'one', title: 'API_TOKEN' },
          { id: 'two', title: 'API_TOKEN' },
        ])
      );
    }
    throw new Error('Unexpected fake command');
  };
  const duplicateAdapter = new OnePasswordAdapter(duplicates);
  await duplicateAdapter.initialize();
  await assert.rejects(
    duplicateAdapter.validateExistingItem('API_TOKEN'),
    /Multiple 1Password items/
  );

  const malformed: CommandExecutor = async request => {
    if (request.args[0] === '--version') return success('2.32.0');
    if (request.args[0] === 'whoami') return success('{}');
    if (request.args[0] === 'vault') return success(JSON.stringify({ id: 'vault_test' }));
    if (request.args[0] === 'item' && request.args[1] === 'list') {
      return success(JSON.stringify([{ id: 'one', title: 'API_TOKEN' }]));
    }
    if (request.args[0] === 'item' && request.args[1] === 'get') {
      return success(
        JSON.stringify({
          id: 'one',
          fields: [{ id: 'password', label: 'password', type: 'STRING', value: '' }],
        })
      );
    }
    throw new Error('Unexpected fake command');
  };
  const malformedAdapter = new OnePasswordAdapter(malformed);
  await malformedAdapter.initialize();
  await assert.rejects(malformedAdapter.validateExistingItem('API_TOKEN'), /password field/);
});

void test('1Password adapter creates and verifies an exact-name concealed item', async () => {
  const requests: CommandRequest[] = [];
  const execute: CommandExecutor = async request => {
    requests.push(request);
    if (request.args[0] === '--version') return success('2.32.0');
    if (request.args[0] === 'whoami') return success('{}');
    if (request.args[0] === 'vault') return success(JSON.stringify({ id: 'vault_test' }));
    if (request.args[0] === 'item' && request.args[1] === 'list') return success('[]');
    if (request.args[0] === 'item' && request.args[1] === 'template') {
      return success(
        JSON.stringify({
          title: '',
          category: 'PASSWORD',
          fields: [{ id: 'password', label: 'password', type: 'CONCEALED', value: '' }],
        })
      );
    }
    if (request.args[0] === 'item' && request.args[1] === 'create') {
      return success(JSON.stringify({ id: 'item_test' }));
    }
    if (
      request.args[0] === 'item' &&
      request.args[1] === 'get' &&
      request.args.includes('--fields')
    ) {
      return success(
        JSON.stringify({ id: 'password', type: 'CONCEALED', value: 'production-secret' })
      );
    }
    throw new Error(`Unexpected fake command: ${request.args.join(' ')}`);
  };

  const adapter = new OnePasswordAdapter(execute);
  await adapter.initialize();
  await adapter.writeProductionValue('add', 'API_TOKEN', 'production-secret');

  const create = requests.find(request => request.args[1] === 'create');
  assert.ok(create?.stdin?.includes('production-secret'));
  assert.equal(create?.args.includes('production-secret'), false);
  assert.ok(create?.stdin?.includes('API_TOKEN'));
  assert.ok(create?.args.includes('vault_test'));
});
