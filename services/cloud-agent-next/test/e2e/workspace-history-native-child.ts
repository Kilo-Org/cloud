import assert from 'node:assert/strict';
import { z } from 'zod';
import { executeDockerCommand, type ControlPlaneKiloRuntime } from './sandbox-control.js';

const CREATE_CHILD_SCRIPT = String.raw`
import fs from 'node:fs';

const input = JSON.parse(process.argv[1]);
const environment = fs.readFileSync('/proc/' + input.processId + '/environ', 'utf8').split('\0');
const read = name => environment.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const password = read('KILO_SERVER_PASSWORD');
if (!password) throw new Error('Owned Kilo listener has no server credential');
const authorization = 'Basic ' + Buffer.from((read('KILO_SERVER_USERNAME') ?? 'kilo') + ':' + password).toString('base64');

async function request(path, body) {
  const url = new URL(path, input.serverUrl);
  url.searchParams.set('directory', input.directory);
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const name = typeof body?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(body.name)
      ? body.name : 'unknown';
    throw new Error('Native child request failed with HTTP ' + response.status + ' (' + name + ')');
  }
  return response.json();
}

let phase = 'root';
try {
  const root = await request('/session/' + encodeURIComponent(input.kiloSessionId));
  if (root.id !== input.kiloSessionId || root.directory !== input.directory || root.parentID) {
    throw new Error('Native child listener ownership changed');
  }
  phase = 'create';
  const child = await request('/session', { parentID: root.id, title: 'DO history acceptance child' });
  if (typeof child.id !== 'string' || child.parentID !== root.id) {
    throw new Error('Native child creation returned an invalid identity');
  }
  phase = 'prompt';
  await request('/session/' + encodeURIComponent(child.id) + '/message', {
    model: { providerID: 'kilo', modelID: input.model.replace(/^kilo\//, '') },
    parts: [{ type: 'text', text: input.prompt }],
  });
  process.stdout.write(JSON.stringify({ kiloSessionId: child.id, parentID: root.id }));
} catch (error) {
  const reason = error instanceof Error && /^(Native child|Owned Kilo listener)/.test(error.message)
    ? error.message : 'native transport error';
  process.stderr.write('Native child setup failed during ' + phase + ': ' + reason + '\n');
  process.exitCode = 1;
}
`;

export async function createNativeHistoryChild(input: {
  runtime: ControlPlaneKiloRuntime;
  model: string;
  prompt: string;
}): Promise<string> {
  const { runtime } = input;
  const { stdout } = await executeDockerCommand([
    'exec',
    runtime.container.id,
    'node',
    '--input-type=module',
    '-e',
    CREATE_CHILD_SCRIPT,
    JSON.stringify({
      processId: runtime.processId,
      serverUrl: runtime.serverUrl,
      directory: runtime.directory,
      kiloSessionId: runtime.kiloSessionId,
      model: input.model,
      prompt: input.prompt,
    }),
  ]);
  const child = z
    .object({ kiloSessionId: z.string(), parentID: z.string() })
    .parse(JSON.parse(stdout));
  assert.equal(child.parentID, runtime.kiloSessionId, 'Native child belongs to another root');
  return child.kiloSessionId;
}
