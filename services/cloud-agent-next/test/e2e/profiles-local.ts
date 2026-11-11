/** Local saved-profile acceptance against the real Worker, database, wrapper, and Kilo v2. */
import assert from 'node:assert/strict';
import { randomUUID, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  agent_environment_profile_agents,
  agent_environment_profile_kilo_commands,
  agent_environment_profile_instructions,
  agent_environment_profile_skills,
  agent_environment_profile_mcp_servers,
} from '@kilocode/db/schema';
import {
  createProfile,
  getProfile,
  setDefaultProfile,
  setVar,
  mergeProfileConfiguration,
  createMcpServer,
} from '@kilocode/cloud-agent-profile';
import { loadRepoEnvFiles, loadDevVars, ensureTestUser } from './auth.js';
import {
  DEFAULT_CONFIG,
  createHostedWorkspace,
  createHostedWorkspaceSession,
  deleteWorktree,
  openConnectedStream,
  sendCommand,
  sendMessage,
  isMessageCompleted,
  type DriverConfig,
  type StreamConnection,
} from './client.js';
import {
  executeDockerCommand,
  findControlPlaneKiloRuntime,
  signalKiloServerProcess,
} from './sandbox-control.js';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadRepoEnvFiles(service);
const database = new URL(process.env.POSTGRES_URL ?? '');
assert(['localhost', '127.0.0.1'].includes(database.hostname), 'Requires a local database');
const manifest = z
  .object({ services: z.array(z.object({ name: z.string(), port: z.number() })) })
  .parse(JSON.parse(await readFile(path.join(service, '../../dev/logs/manifest.json'), 'utf8')));
const port = (name: string) => {
  const found = manifest.services.find(item => item.name === name);
  assert(found, `Local service is missing: ${name}`);
  return found.port;
};
assert.equal(Number(database.port || 5432), port('postgres'), 'Database must belong to this stack');
const vars = loadDevVars(service);
const client = createDrizzleClient({
  connectionString: database.toString(),
  ssl: false,
  poolConfig: { max: 1 },
});
const tag = `profiles-${randomUUID().slice(0, 8)}`;
const user = await ensureTestUser(database.toString(), `${tag}@example.com`, { funded: true });
const config: DriverConfig = {
  ...DEFAULT_CONFIG,
  user,
  nextAuthSecret: vars.NEXTAUTH_SECRET,
  internalApiSecret: vars.INTERNAL_API_SECRET,
  workerUrl: `http://localhost:${port('cloud-agent-next')}`,
  fakeLlmUrl: `http://localhost:${port('fake-llm')}`,
};
const owner = { type: 'user' as const, id: user.id };
const profile = await createProfile(client.db, owner, user.id, 'Synthetic v2 profile acceptance');
const signal = AbortSignal.timeout(180_000);
let stream: StreamConnection | undefined;
let workspaceId: string | undefined;

// This local stdio MCP has no dependencies and never prints its environment.
const mcp = String.raw`
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') require('node:fs').writeFileSync('profile-mcp.txt', process.env.PROFILE_MCP_VALUE === 'synthetic-mcp-value' ? 'PROFILE_MCP_OK' : 'PROFILE_MCP_MISSING');
  const result = request.method === 'initialize'
    ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic-profile',version:'1'}}
    : request.method === 'tools/list'
      ? {tools:[{name:'profile-proof',description:'Synthetic profile proof',inputSchema:{type:'object',properties:{}}}]}
      : request.method === 'tools/call'
        ? {content:[{type:'text',text:process.env.PROFILE_MCP_VALUE === 'synthetic-mcp-value' ? 'PROFILE_MCP_OK' : 'PROFILE_MCP_MISSING'}]}
        : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});`;

let remoteAuthenticated = false;
const remote = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Unexpected MCP request chunk');
    chunks.push(Buffer.from(chunk));
  }
  const rpc = z
    .object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
    .parse(JSON.parse(Buffer.concat(chunks).toString()));
  if (rpc.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  if (rpc.method === 'tools/list')
    remoteAuthenticated = request.headers['x-profile-proof'] === 'synthetic-remote-value';
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result:
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'synthetic-remote', version: '1' },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'remote-proof',
                    description: 'Synthetic remote proof',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              }
            : { content: [{ type: 'text', text: 'PROFILE_REMOTE_OK' }] },
    })
  );
});
await new Promise<void>(resolve => remote.listen(0, '0.0.0.0', resolve));
const address = remote.address();
assert(address && typeof address !== 'string');

try {
  const privateKey = vars.AGENT_ENV_VARS_PRIVATE_KEY?.replaceAll('\\n', '\n');
  assert(
    privateKey,
    'Configure AGENT_ENV_VARS_PRIVATE_KEY in services/cloud-agent-next/.dev.vars before starting the stack'
  );
  const publicKey = Buffer.from(
    createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  ).toString('base64');
  await setVar(
    client.db,
    publicKey,
    profile.id,
    'PROFILE_PLAIN',
    'synthetic-plain-value',
    false,
    owner
  );
  await setVar(
    client.db,
    publicKey,
    profile.id,
    'PROFILE_SECRET',
    'synthetic-secret-value',
    true,
    owner
  );
  await client.db.insert(agent_environment_profile_commands).values([
    { profile_id: profile.id, sequence: 0, command: 'printf first > profile-setup.txt' },
    { profile_id: profile.id, sequence: 1, command: 'exit 17' },
    { profile_id: profile.id, sequence: 2, command: 'printf second >> profile-setup.txt' },
  ]);
  await client.db.insert(agent_environment_profile_agents).values([
    {
      profile_id: profile.id,
      slug: 'profile-reviewer',
      name: 'Profile reviewer',
      config: {
        mode: 'primary',
        prompt: 'SYNTHETIC_PROFILE_AGENT',
        model: 'kilo/fake-deterministic',
        permission: { edit: 'deny' },
      },
    },
    {
      profile_id: profile.id,
      slug: 'profile-helper',
      name: 'Profile helper',
      config: { mode: 'subagent', prompt: 'SYNTHETIC_PROFILE_HELPER' },
    },
    {
      profile_id: profile.id,
      slug: 'profile-disabled',
      name: 'Disabled profile agent',
      config: { disable: true },
    },
  ]);
  await client.db.insert(agent_environment_profile_kilo_commands).values([
    {
      profile_id: profile.id,
      name: 'profile-command',
      template: '__fake__:echo:$ARGUMENTS',
      agent: 'profile-reviewer',
      model: 'kilo/fake-deterministic',
      description: 'Synthetic profile command',
    },
    {
      profile_id: profile.id,
      name: 'profile-task',
      template: '__fake__:echo:$ARGUMENTS',
      agent: 'profile-helper',
      subtask: true,
    },
    {
      profile_id: profile.id,
      name: 'profile-disabled',
      template: '__fake__:echo:disabled',
      enabled: false,
    },
  ]);
  await client.db.insert(agent_environment_profile_instructions).values([
    { profile_id: profile.id, name: 'profile-proof', content: 'SYNTHETIC_PROFILE_INSTRUCTION' },
    {
      profile_id: profile.id,
      name: 'profile-disabled',
      content: 'SYNTHETIC_DISABLED_INSTRUCTION',
      enabled: false,
    },
  ]);
  await client.db.insert(agent_environment_profile_skills).values([
    {
      profile_id: profile.id,
      name: 'profile-review',
      source_type: 'custom',
      raw_markdown:
        '---\nname: profile-review\ndescription: Synthetic custom skill\n---\nRead scripts/check.sh.',
      files: { 'scripts/check.sh': 'echo PROFILE_SKILL_OK' },
    },
    {
      profile_id: profile.id,
      name: 'profile-marketplace',
      source_type: 'marketplace',
      raw_markdown:
        '---\nname: profile-marketplace\ndescription: Synthetic marketplace skill\n---\nReview fixtures.',
    },
    {
      profile_id: profile.id,
      name: 'profile-disabled',
      source_type: 'custom',
      raw_markdown: '---\nname: profile-disabled\ndescription: Disabled skill\n---\nDisabled.',
      enabled: false,
    },
    ...(process.env.RUN_SKILLS_SH_INSTALL_TEST === '1'
      ? [
          {
            profile_id: profile.id,
            name: 'find-skills',
            source_type: 'skills-sh' as const,
            source_url: 'https://skills.sh/vercel-labs/skills/find-skills',
            raw_markdown: '',
          },
        ]
      : []),
  ]);
  await createMcpServer(
    client.db,
    publicKey,
    profile.id,
    {
      name: 'profile-local',
      type: 'local',
      enabled: true,
      config: {
        command: ['node', '-e', mcp],
        environment: { PROFILE_MCP_VALUE: 'synthetic-mcp-value' },
      },
    },
    owner
  );
  await createMcpServer(
    client.db,
    publicKey,
    profile.id,
    {
      name: 'profile-remote',
      type: 'remote',
      enabled: true,
      config: {
        url: `http://host.docker.internal:${address.port}/mcp`,
        headers: { 'x-profile-proof': 'synthetic-remote-value' },
      },
    },
    owner
  );
  await client.db.insert(agent_environment_profile_mcp_servers).values({
    profile_id: profile.id,
    name: 'profile-disabled',
    type: 'remote',
    enabled: false,
    config: { url: 'https://example.invalid/mcp' },
  });
  await setDefaultProfile(client.db, profile.id, owner);
  assert.equal(
    (await mergeProfileConfiguration(client.db, { owner })).resolvedProfileId,
    profile.id
  );
  const saved = await getProfile(client.db, profile.id, owner);
  assert.equal(saved.vars.find(item => item.key === 'PROFILE_SECRET')?.value, '***');
  const [secret] = await client.db
    .select()
    .from(agent_environment_profile_vars)
    .where(
      and(
        eq(agent_environment_profile_vars.profile_id, profile.id),
        eq(agent_environment_profile_vars.key, 'PROFILE_SECRET')
      )
    );
  assert(secret, 'Profile variables were not saved');
  assert(
    !secret.value.includes('synthetic-secret-value'),
    'Profile secret was stored in plaintext'
  );
  console.log('PASS saved profile collections, default selection, and masked secret response');

  const created = await createHostedWorkspace(
    config,
    { profileId: profile.id, prompt: `__fake__:echo:${tag}-cold` },
    signal
  );
  workspaceId = created.workspaceId;
  stream = await openConnectedStream(config, created.cloudAgentSessionId, true, undefined, signal);
  assert(
    isMessageCompleted(await stream.waitForTerminal(120_000, created.messageId), created.messageId),
    'Profile cold turn failed'
  );
  const catalog = await stream.waitFor(
    event =>
      event.streamEventType === 'commands.available' &&
      JSON.stringify(event.data).includes('profile-command'),
    15_000
  );

  const native = await findControlPlaneKiloRuntime(created.kiloSessionId);
  assert(native, 'No owned native profile runtime');
  const inspect = String.raw`
    const fs = require('node:fs');
    const input = JSON.parse(process.argv[1]);
    const env = Object.fromEntries(fs.readFileSync('/proc/'+input.processId+'/environ','utf8').split('\0').filter(Boolean).map(item => { const at=item.indexOf('='); return [item.slice(0,at),item.slice(at+1)]; }));
    const headers = {Authorization:'Basic '+Buffer.from((env.KILO_SERVER_USERNAME || env.OPENCODE_SERVER_USERNAME || 'opencode')+':'+(env.KILO_SERVER_PASSWORD || env.OPENCODE_SERVER_PASSWORD)).toString('base64')};
    const query = '?location[directory]='+encodeURIComponent(input.directory);
    const read = async endpoint => { const response=await fetch(input.serverUrl+endpoint+query,{headers}); if(!response.ok) throw new Error('Native inspection failed: '+response.status); return response.json(); };
    const skills=(await read('/api/skill')).data;
    const agents=(await read('/api/agent')).data;
    const servers=(await read('/api/mcp')).data;
    console.log(JSON.stringify({
      harness:fs.readFileSync('/proc/1/environ','utf8').includes('KILO_RUNTIME_HARNESS=kilo2'),
      profileFile:Boolean(env.KILO2_CONFIG),
      wrapperProfileBridge:fs.readFileSync('/usr/local/bin/kilocode-control-plane-wrapper.js','utf8').includes('KILO2_CONFIG'),
      variables:env.PROFILE_PLAIN==='synthetic-plain-value' && env.PROFILE_SECRET==='synthetic-secret-value',
      setup:fs.readFileSync(input.directory+'/profile-setup.txt','utf8')==='firstsecond',
      rules:fs.readFileSync(input.home+'/.kilocode/rules/profile-proof.md','utf8')==='SYNTHETIC_PROFILE_INSTRUCTION' && !fs.existsSync(input.home+'/.kilocode/rules/profile-disabled.md'),
      companion:fs.readFileSync(input.home+'/.kilocode/skills/profile-review/scripts/check.sh','utf8')==='echo PROFILE_SKILL_OK',
      mcpEnvironment:fs.readFileSync(input.directory+'/profile-mcp.txt','utf8')==='PROFILE_MCP_OK',
      skills:skills.map(item=>item.name),agents:agents.map(item=>item.name),
      mcp:servers.map(item=>({name:item.name,status:item.status.status})),
    }));
  `;
  const proof = z
    .object({
      harness: z.boolean(),
      profileFile: z.boolean(),
      wrapperProfileBridge: z.boolean(),
      variables: z.boolean(),
      setup: z.boolean(),
      rules: z.boolean(),
      companion: z.boolean(),
      mcpEnvironment: z.boolean(),
      skills: z.array(z.string()),
      agents: z.array(z.string()),
      mcp: z.array(z.object({ name: z.string(), status: z.string() })),
    })
    .parse(
      JSON.parse(
        (
          await executeDockerCommand([
            'exec',
            native.container.id,
            'bun',
            '-e',
            inspect,
            JSON.stringify(native),
          ])
        ).stdout
      )
    );
  console.log(JSON.stringify(proof));
  assert(catalog, 'Cloud did not publish the loaded profile command');
  assert(
    !JSON.stringify(catalog.data).includes('profile-disabled'),
    'Disabled command was published'
  );
  console.log('PASS cold start and Cloud slash-command discovery');
  for (const key of [
    'harness',
    'profileFile',
    'wrapperProfileBridge',
    'variables',
    'setup',
    'rules',
    'companion',
    'mcpEnvironment',
  ] as const)
    assert(proof[key], `Profile proof failed: ${key}`);
  for (const name of [
    'profile-review',
    'profile-marketplace',
    ...(process.env.RUN_SKILLS_SH_INSTALL_TEST === '1' ? ['find-skills'] : []),
  ])
    assert(proof.skills.includes(name), `Missing skill: ${name}`);
  assert(!proof.skills.includes('profile-disabled'));
  assert(proof.agents.includes('profile-reviewer') && proof.agents.includes('profile-helper'));
  assert(!proof.agents.includes('profile-disabled'));
  assert(proof.mcp.some(item => item.name === 'profile-local' && item.status === 'connected'));
  assert(proof.mcp.some(item => item.name === 'profile-remote' && item.status === 'connected'));
  assert(remoteAuthenticated, 'Remote MCP did not receive its decrypted profile header');
  assert(!proof.mcp.some(item => item.name === 'profile-disabled'));
  console.log(
    'PASS v2 runtime, variables, decrypted secrets, non-fatal ordered setup, instructions, agents, skills, companion files, and local/remote MCP'
  );

  async function command(name: string) {
    const result = await sendCommand(config, {
      cloudAgentSessionId: created.cloudAgentSessionId,
      command: name,
      arguments: `${tag}-${name}`,
      signal,
    });
    assert(
      isMessageCompleted(
        (await stream?.waitForTerminal(45_000, result.messageId)) ?? null,
        result.messageId
      ),
      `Profile command failed: ${name}`
    );
    console.log(`PASS /${name}`);
  }
  await command('profile-command');
  await command('profile-task');
  const sibling = await createHostedWorkspaceSession(
    config,
    { workspaceId, prompt: `__fake__:echo:${tag}-sibling` },
    signal
  );
  const siblingStream = await openConnectedStream(
    config,
    sibling.cloudAgentSessionId,
    true,
    undefined,
    signal
  );
  try {
    assert(
      isMessageCompleted(
        await siblingStream.waitForTerminal(45_000, sibling.messageId),
        sibling.messageId
      )
    );
    assert(
      await siblingStream.waitFor(
        event =>
          event.streamEventType === 'commands.available' &&
          JSON.stringify(event.data).includes('profile-command'),
        10_000
      )
    );
  } finally {
    siblingStream.close();
  }
  console.log('PASS sibling profile reuse');

  await signalKiloServerProcess(
    { containerId: native.container.id, processId: native.processId },
    'KILL'
  );
  const recovered = await sendMessage(config, {
    cloudAgentSessionId: created.cloudAgentSessionId,
    prompt: `__fake__:echo:${tag}-recovered`,
    signal,
  });
  assert(
    isMessageCompleted(
      await stream.waitForTerminal(45_000, recovered.messageId),
      recovered.messageId
    )
  );
  await command('profile-command');
  console.log('PASS profile retained after native process restart');
} finally {
  stream?.close();
  try {
    if (workspaceId)
      await deleteWorktree(config, { worktreeId: workspaceId }, AbortSignal.timeout(30_000));
  } finally {
    remote.closeAllConnections();
    remote.close();
    await client.db
      .delete(agent_environment_profiles)
      .where(eq(agent_environment_profiles.id, profile.id));
    await client.pool.end();
  }
}
