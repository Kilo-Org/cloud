import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import WebSocket from 'ws';
import { z } from 'zod';
import { createMessageId, MESSAGE_ID_PATTERN } from '../../src/session/message-id.js';
import { onPremProfileSchema, onPremStatusSchema } from '../../src/shared/onprem-protocol.js';
import type { FakeScenarioStatus } from './fake-llm-server.js';
import {
  CheckError,
  ROOT,
  check,
  messageSchema,
  parse,
  partSchema,
  sessionSchema,
  until,
} from './multichat-real-support.js';
import {
  imageIdSchema,
  kubernetesInspector,
  localUrl,
  namespaceSchema,
  readPrivateFile,
  type OnPremIdentity,
} from './onprem-kubernetes.js';

const MODEL = 'kilo/fake-deterministic';
const ORG = 'organizations.cloudAgentNext';
const idSchema = z
  .string()
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const outcomeSchema = z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']);
const resultSchema = z.object({
  cloudAgentSessionId: sessionSchema.shape.cloudAgentSessionId,
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
  status: outcomeSchema,
  acceptedAt: z.number().optional(),
  terminalAt: z.number().optional(),
});
const countersSchema = z.object({
  write: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  edit: z.number().int().nonnegative(),
  question: z.number().int().nonnegative(),
});
const fakeStatusSchema = z.object({
  tag: idSchema,
  requests: z.number().int().nonnegative(),
  toolCalls: countersSchema,
  toolResults: countersSchema,
  unsupportedToolSchema: z.boolean(),
}) satisfies z.ZodType<FakeScenarioStatus>;
const snapshotSchema = z.object({
  sessionId: sessionSchema.shape.cloudAgentSessionId,
  kiloSessionId: sessionSchema.shape.kiloSessionId,
  userId: idSchema,
  orgId: z.uuid(),
  sandboxId: z.string().regex(/^ses-[a-f0-9]{48}$/),
  model: z.string(),
  autoCommit: z.boolean(),
  gitUrl: z.string(),
  upstreamBranch: z.string(),
  initialMessageId: z.string().regex(MESSAGE_ID_PATTERN).optional(),
});
const ownershipSchema = z.object({
  session_id: sessionSchema.shape.kiloSessionId,
  kilo_user_id: idSchema,
  organization_id: z.uuid(),
  cloud_agent_session_id: sessionSchema.shape.cloudAgentSessionId,
  cloud_agent_worktree_id: z
    .string()
    .regex(/^worktree_[a-f0-9-]{36}$/)
    .nullable(),
  created_on_platform: z.string(),
});
const transcriptSchema = z.object({
  info: z.object({ id: sessionSchema.shape.kiloSessionId }),
  messages: z.array(z.object({ info: messageSchema, parts: z.array(partSchema) })),
});
type Chat = z.infer<typeof sessionSchema> & { label: string; sandboxId?: string };
type Turn = {
  label: string;
  tag: string;
  messageId: string;
  prompt: string;
  expected: 'completed' | 'interrupted';
  write?: string;
  read?: string;
  replacement?: string;
  chat?: Chat;
  actual?: z.infer<typeof resultSchema>;
  fake?: FakeScenarioStatus;
  releaseAttempted?: boolean;
  outcomePath?: string;
  transcriptPath?: string;
};
type Phase = {
  name: string;
  expected: string;
  status: 'not_run' | 'running' | 'passed' | 'failed' | 'blocked';
  detail?: string;
};
type Mutation = {
  operation: string;
  requested: Record<string, string>;
  at: string;
  outcome: 'pending' | 'acknowledged' | 'rejected' | 'ambiguous';
  httpStatus?: number;
  returned?: Record<string, string>;
};
class HttpFailure extends CheckError {
  constructor(readonly status: number) {
    super(`Local HTTP request failed (${status}); response body omitted, no mutation replayed`);
  }
}

function options() {
  const { values } = parseArgs({
    options: {
      auth: { type: 'string' },
      out: { type: 'string' },
      'organization-id': { type: 'string' },
      'installation-id': { type: 'string' },
      'runtime-class': { type: 'string' },
      image: { type: 'string' },
      'expected-image-id': { type: 'string' },
      kubeconfig: { type: 'string' },
      context: { type: 'string' },
      'git-url': { type: 'string' },
      'git-fixture-origin': { type: 'string' },
      branch: { type: 'string' },
      'worker-url': { type: 'string' },
      'web-url': { type: 'string' },
      'ingest-url': { type: 'string' },
      'fake-llm-url': { type: 'string' },
      'system-namespace': { type: 'string', default: 'kilo-onprem-system' },
      'turn-timeout-seconds': { type: 'string', default: '180' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm exec tsx services/cloud-agent-next/test/e2e/onprem.ts --auth <private.json> --organization-id <uuid> --kubeconfig <private-kubeconfig> --context <context> --installation-id <uuid> --runtime-class <class> --image <image> [--expected-image-id <verified-CRI-imageID>] --git-url <https://github.com/owner/repository.git> --git-fixture-origin <local-origin> --branch <branch> --out dev/logs/<NEW-directory> [--worker-url <origin> --web-url <origin> --ingest-url <origin> --fake-llm-url <origin>] [--system-namespace kilo-onprem-system] [--turn-timeout-seconds 180]'
    );
    console.log(
      'Omit all four service URLs to read dev/logs/manifest.json. Prepared local stack only; no enrollment, selection changes, mutation retries, VM bootstrap, or resource sweeps. Runtime/credential isolation qualification and disconnect/revocation remain separate manual proofs.'
    );
    return;
  }
  check(
    values.auth &&
      values.out &&
      values.kubeconfig &&
      values.context &&
      values['git-url'] &&
      values['git-fixture-origin'] &&
      values.branch,
    'Required: --auth, --out, --kubeconfig, --context, --git-url, --git-fixture-origin, --branch'
  );
  const expected = parse(
    z.object({
      organizationId: z.uuid(),
      installationId: z.uuid(),
      runtimeClass: onPremProfileSchema.shape.runtimeClass,
      image: onPremProfileSchema.shape.image,
      expectedImageId: imageIdSchema.optional(),
    }),
    {
      organizationId: values['organization-id'],
      installationId: values['installation-id'],
      runtimeClass: values['runtime-class'],
      image: values.image,
      expectedImageId: values['expected-image-id'],
    },
    'Expected identities'
  );
  const names = {
    worker: 'cloud-agent-next',
    web: 'nextjs',
    ingest: 'cloudflare-session-ingest',
    fake: 'fake-llm',
  };
  const supplied = {
    worker: values['worker-url'],
    web: values['web-url'],
    ingest: values['ingest-url'],
    fake: values['fake-llm-url'],
  };
  check(
    Object.values(supplied).every(Boolean) || Object.values(supplied).every(value => !value),
    'Supply all four service URLs, or none'
  );
  const manifest = supplied.worker
    ? undefined
    : parse(
        z.object({
          services: z.array(
            z.object({ name: z.string(), port: z.number().int().min(0).max(65535) })
          ),
        }),
        JSON.parse(readFileSync(resolve(ROOT, 'dev/logs/manifest.json'), 'utf8')) as unknown,
        'Worktree service manifest'
      );
  function endpoint(target: keyof typeof names) {
    const matches = manifest?.services.filter(service => service.name === names[target]);
    const service = matches?.[0];
    check(
      supplied[target] || (matches?.length === 1 && service && service.port > 0),
      'Missing or ambiguous local service manifest entry'
    );
    const url = localUrl(supplied[target] ?? `http://127.0.0.1:${service?.port}`, `${target} URL`);
    check(url.pathname === '/', 'Service URLs must be origins');
    return url.origin;
  }
  const base = {
    worker: endpoint('worker'),
    web: endpoint('web'),
    ingest: endpoint('ingest'),
    fake: endpoint('fake'),
  };
  check(
    new Set(Object.values(base)).size === 4,
    'Worker, web, ingest and fake endpoints must be distinct'
  );
  const fixture = new URL(parse(z.url(), values['git-url'], 'Logical Git fixture'));
  check(
    fixture.origin === 'https://github.com' &&
      !fixture.username &&
      !fixture.password &&
      !fixture.search &&
      !fixture.hash &&
      fixture.href === values['git-url'] &&
      /^\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.git$/.test(fixture.pathname),
    'A canonical credential-free logical https://github.com/owner/repository.git URL is required'
  );
  const fixtureOrigin = localUrl(values['git-fixture-origin'], 'Git fixture origin', true);
  check(fixtureOrigin.pathname === '/', 'Git fixture override must be a local origin');
  const branch = parse(
    z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
      .refine(
        value =>
          !value.includes('..') &&
          !value.endsWith('.') &&
          value
            .split('/')
            .every(
              segment =>
                segment.length > 0 && !segment.startsWith('.') && !segment.endsWith('.lock')
            )
      ),
    values.branch,
    'Fixture branch'
  );
  const timeoutSeconds = Number(values['turn-timeout-seconds']);
  check(
    Number.isInteger(timeoutSeconds) && timeoutSeconds >= 30 && timeoutSeconds <= 600,
    'Turn timeout must be 30–600 seconds'
  );
  parse(idSchema, values.context, 'Kubernetes context');
  return {
    ...expected,
    authPath: values.auth,
    outPath: values.out,
    kubeconfig: values.kubeconfig,
    context: values.context,
    gitUrl: fixture.href,
    fixtureOrigin: fixtureOrigin.origin,
    branch,
    base,
    timeoutMs: timeoutSeconds * 1000,
    systemNamespace: parse(namespaceSchema, values['system-namespace'], 'System namespace'),
  };
}

function evidenceDirectory(outPath: string, token: string) {
  const out = resolve(ROOT, outPath);
  const parent = resolve(ROOT, 'dev/logs');
  check(
    dirname(out) === parent &&
      realpathSync(parent) === parent &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(basename(out)),
    'Evidence must be a NEW direct child of this worktree dev/logs'
  );
  try {
    execFileSync('git', ['check-ignore', '-q', '--', `${relative(ROOT, out)}/evidence.json`], {
      cwd: ROOT,
      stdio: 'pipe',
    });
  } catch {
    throw new CheckError('Evidence directory must be git-ignored');
  }
  mkdirSync(out, { mode: 0o700 });
  function save(name: string, value: unknown) {
    const stat = lstatSync(out);
    check(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o7777) === 0o700,
      'Evidence directory is no longer private'
    );
    const text = JSON.stringify(value, null, 2).split(token).join('[redacted]');
    const temporary = resolve(out, `${name}.tmp`);
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, resolve(out, name));
  }
  return { path: relative(ROOT, out), save };
}

function returnedIds(value: unknown): Record<string, string> {
  const object = z.record(z.string(), z.unknown()).safeParse(value);
  if (!object.success) return {};
  const cloudId = z.string().regex(/^(?:agent|workspace)_[a-f0-9-]{36}$/);
  const ptyId = z.string().regex(/^pty_[A-Za-z0-9_-]{1,124}$/);
  const fields = {
    cloudAgentSessionId: cloudId,
    sessionId: cloudId,
    kiloSessionId: sessionSchema.shape.kiloSessionId,
    sourceKiloSessionId: sessionSchema.shape.kiloSessionId,
    messageId: z.string().regex(MESSAGE_ID_PATTERN),
    worktreeId: ownershipSchema.shape.cloud_agent_worktree_id.unwrap(),
    ptyId,
    operationKey: z.uuid(),
  };
  const ids: Record<string, string> = {};
  for (const [key, schema] of Object.entries(fields)) {
    const parsed = schema.safeParse(object.data[key]);
    if (parsed.success) ids[key] = parsed.data;
  }
  const message = z.object({ id: fields.messageId }).safeParse(object.data.message);
  if (message.success) ids.messageId = message.data.id;
  const pty = z.object({ id: ptyId }).safeParse(object.data.pty);
  if (pty.success) ids.ptyId = pty.data.id;
  return ids;
}

async function run(config: NonNullable<ReturnType<typeof options>>, signal: AbortSignal) {
  const auth = parse(
    z.object({ token: z.string().min(1).max(16384), userId: idSchema }),
    JSON.parse(readPrivateFile(config.authPath)) as unknown,
    'Private auth'
  );
  const evidence = evidenceDirectory(config.outPath, auth.token);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const filename = `onprem-${runId}.txt`;
  const phases: Phase[] = Object.entries({
    preflight: 'Local targets, native user/org authorization and expected selected installation',
    cold: 'Real write tool, exact completed turn/transcript and owned onprem Pod identity',
    warm: 'Real read/edit of the cold file and the same Pod UID',
    'reverse-pty': 'Terminal API marker, verified stty resize and confirmed close',
    'sibling-stop':
      'Same worktree/allocation; Stop affects only the first chat while its sibling completes',
  }).map(([name, expected]) => ({ name, expected, status: 'not_run' }));
  const manual = Object.entries({
    'control-disconnect-recovery':
      'Held control disconnect, confirmed cleanup, explicit same-chat recovery with a NEW Pod UID',
    'active-installation-revocation':
      'Active revocation, confirmed cleanup, denied work and no cloud fallback',
    'credential-egress-gvisor':
      'Separate trusted denial and gVisor probes; RuntimeClass alone is not isolation proof',
  }).map(([name, expected]) => ({ name, expected, status: 'not_run' }));
  const chats: Chat[] = [];
  const turns: Turn[] = [];
  const mutations: Mutation[] = [];
  const identities: { phase: string; identity: OnPremIdentity }[] = [];
  const reconciliations: Record<string, unknown>[] = [];
  let nativeFilePath: string | undefined;
  let status: 'running' | 'passed' | 'failed' = 'running';
  function reportedStatus() {
    return status === 'passed' && phases.some(phase => phase.status === 'blocked')
      ? 'blocked'
      : status;
  }
  let failure: string | undefined;
  let preflight: Record<string, unknown> | undefined;
  let terminal:
    | {
        cloudAgentSessionId: string;
        ptyId: string;
        marker?: string;
        resize?: { rows: number; cols: number };
        closeAttempted?: boolean;
        closeCode?: number;
        closed?: boolean;
      }
    | undefined;
  function persist() {
    evidence.save('evidence.json', {
      runId,
      startedAt,
      updatedAt: new Date().toISOString(),
      status: reportedStatus(),
      failure,
      expected: {
        organizationId: config.organizationId,
        installationId: config.installationId,
        runtimeClass: config.runtimeClass,
        image: config.image,
        imageID: config.expectedImageId,
        upstreamBranch: config.branch,
        model: MODEL,
      },
      userId: auth.userId,
      endpoints: config.base,
      fixturePath: new URL(config.gitUrl).pathname,
      filename,
      preflight,
      phases,
      chats,
      turns,
      mutations,
      identities,
      terminal,
      reconciliations,
      manual,
      evidenceDirectory: evidence.path,
      limits: [
        'Native Kilo user Bearer only; no internal key, token minting or balance bypass.',
        'Generic-Git public start has no prepare-only or shared-worktree creation contract. Exact durable message results plus native transcript exports are the turn oracle; chat streaming/UI are not tested.',
        'The logical GitHub URL must map to the explicit local fixture origin. Generic read-only Git only: no GitHub API, credentials, commits or pushes.',
        'Pod spec.image and CRI imageID are recorded separately. Only an explicit --expected-image-id is compared with imageID; no manifest/index digest equivalence is inferred.',
        'Kubernetes inspection uses installation-scoped configuration/ledgers, then their exact Pod reference. No Docker, socket discovery, kubectl exec or Pod deletion.',
        'The running local stack must match its frozen worktree configuration. Snapshots are sanitized assertion projections, not raw exports.',
        'Only owned sockets, a known PTY and unique fake gates are closed. Chats, files and allocations remain for the operator; ambiguous mutations are never replayed.',
      ],
    });
  }
  async function phase(name: string, action: () => Promise<void>) {
    const entry = phases.find(item => item.name === name);
    check(entry, 'Unknown scenario');
    entry.status = 'running';
    persist();
    try {
      await action();
      if (entry.status === 'running') entry.status = 'passed';
    } catch (error) {
      entry.status = 'failed';
      throw error;
    } finally {
      persist();
    }
  }
  async function http(
    target: keyof typeof config.base,
    path: string,
    method: 'GET' | 'POST' = 'GET',
    input?: unknown,
    cleanup = false
  ): Promise<unknown> {
    const mutation: Mutation | undefined =
      method === 'POST'
        ? {
            operation: `${target}:${path.split('?')[0]}`,
            requested: returnedIds(input),
            at: new Date().toISOString(),
            outcome: 'pending',
          }
        : undefined;
    if (mutation) {
      mutations.push(mutation);
      persist();
    }
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(new URL(path, config.base[target]), {
        method,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(target === 'fake' ? {} : { Authorization: `Bearer ${auth.token}` }),
        },
        body: method === 'POST' ? JSON.stringify(input) : undefined,
        signal: cleanup
          ? AbortSignal.timeout(10_000)
          : AbortSignal.any([signal, AbortSignal.timeout(method === 'POST' ? 90_000 : 15_000)]),
      });
      if (mutation) mutation.httpStatus = response.status;
      const text = await response.text();
      check(text.length <= 8 * 1_048_576, 'Response exceeds evidence-driver limit');
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      if (mutation) {
        mutation.outcome = 'ambiguous';
        persist();
      }
      throw new CheckError(
        'Local request transport/response failure; outcome may be ambiguous, no mutation replayed'
      );
    }
    if (mutation) {
      const envelope = z.object({ result: z.object({ data: z.unknown() }) }).safeParse(body);
      mutation.returned = returnedIds(envelope.success ? envelope.data.result.data : body);
      mutation.outcome = response.ok
        ? 'acknowledged'
        : response.status < 500
          ? 'rejected'
          : 'ambiguous';
      persist();
    }
    if (!response.ok) throw new HttpFailure(response.status);
    return body;
  }
  async function rpc(
    target: 'worker' | 'web',
    procedure: string,
    input: unknown,
    method: 'GET' | 'POST' = 'POST',
    cleanup = false
  ) {
    const path = `${target === 'web' ? '/api' : ''}/trpc/${procedure}`;
    const body = await http(
      target,
      method === 'GET' ? `${path}?input=${encodeURIComponent(JSON.stringify(input))}` : path,
      method,
      method === 'POST' ? input : undefined,
      cleanup
    );
    return parse(z.object({ result: z.object({ data: z.unknown() }) }), body, 'tRPC response')
      .result.data;
  }
  function newTurn(
    label: string,
    spec: Pick<Turn, 'write' | 'read' | 'replacement'> = {},
    expected: Turn['expected'] = 'completed'
  ): Turn {
    const tag = `onprem-${label}-${runId}`;
    const directive = spec.write
      ? `write-then-gate:${tag}:${filename}:${spec.write}`
      : spec.read
        ? `read-edit-then-gate:${tag}:${filename}:${spec.replacement}`
        : `gate:${tag}:done-${tag}`;
    const turn: Turn = {
      label,
      tag,
      messageId: createMessageId(),
      prompt: `__fake__:${directive}`,
      expected,
      ...spec,
    };
    turns.push(turn);
    persist();
    return turn;
  }
  async function result(turn: Turn) {
    check(turn.chat, 'Turn has no reconciled chat identity');
    const value = parse(
      resultSchema,
      await rpc(
        'worker',
        'getMessageResult',
        { cloudAgentSessionId: turn.chat.cloudAgentSessionId, messageId: turn.messageId },
        'GET'
      ),
      'Exact message result'
    );
    check(
      value.cloudAgentSessionId === turn.chat.cloudAgentSessionId &&
        value.messageId === turn.messageId,
      'Message result identity mismatch'
    );
    turn.actual = value;
    persist();
    return value;
  }
  async function metadata(chat: Chat) {
    const snapshot = parse(
      snapshotSchema,
      await rpc('worker', 'getSession', { cloudAgentSessionId: chat.cloudAgentSessionId }, 'GET'),
      'Workspace snapshot'
    );
    check(
      snapshot.sessionId === chat.cloudAgentSessionId &&
        snapshot.kiloSessionId === chat.kiloSessionId &&
        snapshot.userId === auth.userId &&
        snapshot.orgId === config.organizationId &&
        snapshot.model === MODEL &&
        snapshot.autoCommit === false &&
        snapshot.gitUrl === config.gitUrl &&
        snapshot.upstreamBranch === config.branch,
      'Workspace identity, model or finalization mismatch'
    );
    if (chat.sandboxId)
      check(chat.sandboxId === snapshot.sandboxId, 'Workspace allocation changed');
    chat.sandboxId = snapshot.sandboxId;
    const owner = parse(
      ownershipSchema,
      await rpc('web', 'cliSessionsV2.get', { session_id: chat.kiloSessionId }, 'GET'),
      'Native session ownership'
    );
    check(
      owner.session_id === chat.kiloSessionId &&
        owner.cloud_agent_session_id === chat.cloudAgentSessionId &&
        owner.kilo_user_id === auth.userId &&
        owner.organization_id === config.organizationId &&
        owner.created_on_platform === 'cloud-agent-web',
      'Native organization/session provenance mismatch'
    );
    if (chat.worktreeId)
      check(chat.worktreeId === owner.cloud_agent_worktree_id, 'Worktree ownership changed');
    chat.worktreeId = owner.cloud_agent_worktree_id ?? undefined;
    persist();
    return snapshot;
  }
  async function send(chat: Chat, turn: Turn) {
    turn.chat = chat;
    persist();
    const sent = parse(
      z.object({
        messageId: z.string().regex(MESSAGE_ID_PATTERN),
        delivery: z.enum(['sent', 'queued']),
      }),
      await rpc('worker', 'send', {
        cloudAgentSessionId: chat.cloudAgentSessionId,
        message: { id: turn.messageId, prompt: turn.prompt },
        agent: { mode: 'code', model: MODEL },
        finalization: { autoCommit: false },
      }),
      'Send acknowledgment'
    );
    check(sent.messageId === turn.messageId, 'Send acknowledgment message ID mismatch');
  }
  async function gate(turn: Turn) {
    await until('Exact fake turn held', config.timeoutMs, signal, async () => {
      const state = await result(turn);
      check(
        state.status === 'queued' || state.status === 'running',
        'Turn terminalized before its fake gate'
      );
      turn.fake = parse(
        fakeStatusSchema,
        await http('fake', `/test/scenario-status?tag=${turn.tag}`),
        'Fake scenario status'
      );
      check(
        turn.fake.tag === turn.tag && !turn.fake.unsupportedToolSchema,
        'Fake directive/tool schema unsupported'
      );
      const held = parse(
        z.object({ tag: z.string(), engaged: z.boolean() }),
        await http('fake', `/test/gate-status?tag=${turn.tag}`),
        'Fake gate'
      );
      check(held.tag === turn.tag, 'Fake gate identity mismatch');
      if (!held.engaged || state.status !== 'running') return undefined;
      for (const kind of turn.write
        ? (['write'] as const)
        : turn.read
          ? (['read', 'edit'] as const)
          : []) {
        check(
          turn.fake.toolCalls[kind] === 1 && turn.fake.toolResults[kind] === 1,
          'Required real tool call/result missing or duplicated'
        );
      }
      persist();
      return true;
    });
  }
  async function release(turn: Turn, cleanup = false) {
    check(!turn.releaseAttempted, 'Fake gate release must not be replayed');
    turn.releaseAttempted = true;
    persist();
    await http('fake', `/test/release?tag=${turn.tag}`, 'POST', undefined, cleanup);
  }
  async function settle(turn: Turn) {
    await until('Exact native message outcome', config.timeoutMs, signal, async () => {
      const value = await result(turn);
      if (value.status === 'queued' || value.status === 'running') return undefined;
      check(value.status === turn.expected, 'Exact message outcome differs from expectation');
      turn.outcomePath = `${evidence.path}/${turn.label}-outcome.json`;
      evidence.save(`${turn.label}-outcome.json`, { expected: turn.expected, actual: value });
      persist();
      return true;
    });
  }
  async function transcript(turn: Turn) {
    check(turn.chat, 'Missing transcript chat');
    const chat = turn.chat;
    await until('Eventually consistent transcript assertion', 90_000, signal, async () => {
      let raw: unknown;
      try {
        raw = await http('ingest', `/api/session/${chat.kiloSessionId}/export`);
      } catch (error) {
        if (error instanceof HttpFailure && error.status === 404) return undefined;
        throw error;
      }
      const parsed = transcriptSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      const history = parsed.data;
      check(history.info.id === chat.kiloSessionId, 'Export session identity mismatch');
      const own = turns.filter(value => value.chat?.kiloSessionId === chat.kiloSessionId);
      const seen = new Set<string>();
      const partIds = new Set<string>();
      for (const message of history.messages) {
        check(
          !seen.has(message.info.id) && message.info.sessionID === chat.kiloSessionId,
          'Duplicate or foreign native message'
        );
        seen.add(message.info.id);
        check(
          own.some(
            value =>
              value.messageId ===
              (message.info.role === 'user' ? message.info.id : message.info.parentID)
          ),
          'Unexpected user admission or orphan/sibling assistant in transcript'
        );
        for (const part of message.parts) {
          check(
            !partIds.has(part.id) &&
              part.sessionID === chat.kiloSessionId &&
              part.messageID === message.info.id,
            'Duplicate or foreign native part'
          );
          partIds.add(part.id);
        }
      }
      const user = history.messages.find(
        message => message.info.id === turn.messageId && message.info.role === 'user'
      );
      const assistants = history.messages.filter(
        message => message.info.role === 'assistant' && message.info.parentID === turn.messageId
      );
      const parts = assistants.flatMap(message => message.parts);
      if (!user?.parts.some(part => part.type === 'text' && part.text?.includes(turn.prompt)))
        return undefined;
      if (turn.expected === 'interrupted') {
        check(
          !assistants.some(
            message =>
              !message.info.error &&
              message.info.finish &&
              !['tool-calls', 'tool_calls', 'tool_use'].includes(message.info.finish)
          ),
          'Interrupted turn acquired a successful native finish'
        );
        if (!assistants.some(message => message.info.error?.name === 'MessageAbortedError'))
          return undefined;
      } else {
        check(
          !assistants.some(message => message.info.error) &&
            !parts.some(part => part.type === 'tool' && part.state?.status === 'error'),
          'Native assistant/tool failed in a completed turn'
        );
        if (
          !assistants.some(
            message =>
              message.info.time?.completed &&
              message.info.finish &&
              !['tool-calls', 'tool_calls', 'tool_use'].includes(message.info.finish) &&
              message.parts.some(
                part =>
                  part.type === 'text' &&
                  !part.synthetic &&
                  part.text?.trim() === `done-${turn.tag}`
              )
          )
        )
          return undefined;
      }
      const tools = parts.filter(part => part.type === 'tool');
      const proof: {
        tool: string;
        partId: string;
        callId: string;
        file: string;
        expectedContents: string;
      }[] = [];
      for (const kind of turn.write
        ? (['write'] as const)
        : turn.read
          ? (['read', 'edit'] as const)
          : []) {
        const matches = tools.filter(
          part => part.tool === kind && part.state?.status === 'completed'
        );
        if (!matches.length) return undefined;
        check(matches.length === 1, 'Duplicate native file tool');
        const part = matches[0];
        const path = part.state?.input?.filePath;
        check(
          typeof path === 'string' &&
            (path === filename || path.endsWith(`/${filename}`)) &&
            !path.split('/').includes('..'),
          'Native file tool targeted a different file'
        );
        if (nativeFilePath)
          check(path === nativeFilePath, 'Warm/sibling tool targeted a different workspace path');
        else nativeFilePath = path;
        check(
          kind === 'write'
            ? part.state?.input?.content === turn.write
            : kind === 'read'
              ? part.state?.output?.includes(turn.read ?? '')
              : part.state?.input?.oldString === turn.read &&
                part.state?.input?.newString === turn.replacement,
          'Native file contents do not match this turn'
        );
        proof.push({
          tool: kind,
          partId: parse(idSchema, part.id, 'Native part ID'),
          callId: parse(idSchema, part.callID, 'Native tool call ID'),
          file: filename,
          expectedContents:
            (kind === 'write' ? turn.write : kind === 'read' ? turn.read : turn.replacement) ?? '',
        });
      }
      turn.transcriptPath = `${evidence.path}/${turn.label}-transcript.json`;
      evidence.save(`${turn.label}-transcript.json`, {
        kiloSessionId: chat.kiloSessionId,
        messageId: turn.messageId,
        promptMatched: true,
        assistantMessageIds: assistants.map(message =>
          parse(idSchema, message.info.id, 'Native assistant ID')
        ),
        actualAssistantText: turn.expected === 'completed' ? `done-${turn.tag}` : null,
        nativeOutcome: turn.expected,
        tools: proof,
        messages: seen.size,
        parts: partIds.size,
        projection:
          'Only asserted fixture text and validated identities retained; raw transport, transcript, environment and credential contents omitted',
      });
      return true;
    });
  }
  let inspector: ReturnType<typeof kubernetesInspector> | undefined;
  async function identity(chat: Chat, phaseName: string, previous?: OnPremIdentity) {
    check(
      inspector && chat.sandboxId,
      'Missing explicit Kubernetes inspector or authoritative sandbox ID'
    );
    const inspect = inspector.inspect;
    const sandboxId = chat.sandboxId;
    const value = await until('Owned onprem Pod', config.timeoutMs, signal, async () =>
      inspect(sandboxId)
    );
    identities.push({ phase: phaseName, identity: value });
    persist();
    const container = value.pod.containers[0];
    check(
      value.pod.runtimeClass === config.runtimeClass &&
        value.pod.containers.length === 1 &&
        container?.name === 'sandbox' &&
        container.image === config.image &&
        container.running &&
        container.restartCount === 0 &&
        container.imageID &&
        value.pod.phase === 'Running' &&
        !value.pod.deleting,
      'Actual Pod runtime/image/state differs from expectation'
    );
    if (config.expectedImageId) {
      check(
        container.imageID === config.expectedImageId,
        'CRI imageID differs from the explicitly verified expected imageID'
      );
    }
    check(
      previous
        ? previous.pod.uid === value.pod.uid &&
            previous.allocationId === value.allocationId &&
            previous.sandboxId === value.sandboxId &&
            previous.pod.containers[0]?.imageID === container.imageID
        : Date.parse(value.pod.createdAt) >= Date.parse(startedAt) - 5000,
      'Expected a fresh cold Pod or the exact same warm allocation/UID/imageID'
    );
    return value;
  }
  async function closeTerminal(cleanup = false) {
    check(terminal && !terminal.closeAttempted, 'PTY close must not be replayed');
    terminal.closeAttempted = true;
    persist();
    const closed = parse(
      z.object({ success: z.boolean() }),
      await rpc(
        'web',
        `${ORG}.closeTerminal`,
        {
          organizationId: config.organizationId,
          cloudAgentSessionId: terminal.cloudAgentSessionId,
          ptyId: terminal.ptyId,
        },
        'POST',
        cleanup
      ),
      'PTY close'
    );
    check(closed.success, 'PTY close was not confirmed');
    terminal.closed = true;
    persist();
  }
  async function pty(chat: Chat) {
    const created = await rpc('web', `${ORG}.createTerminal`, {
      organizationId: config.organizationId,
      cloudAgentSessionId: chat.cloudAgentSessionId,
      cols: 80,
      rows: 24,
    });
    const ids = parse(z.object({ ptyId: idSchema }), created, 'Created PTY identity');
    terminal = { cloudAgentSessionId: chat.cloudAgentSessionId, ptyId: ids.ptyId };
    persist();
    const data = parse(
      z.object({
        ptyId: idSchema,
        pty: z.object({ id: idSchema, status: z.literal('running') }),
        wsUrl: z.string(),
      }),
      created,
      'Created PTY'
    );
    check(data.pty.id === data.ptyId, 'PTY creation identity mismatch');
    const url = new URL(data.wsUrl, config.base.worker);
    const unsigned = new URL(url);
    unsigned.search = '';
    unsigned.protocol = unsigned.protocol.replace(/^ws/, 'http');
    check(
      localUrl(unsigned.toString(), 'PTY transport').origin === config.base.worker &&
        url.pathname === '/terminal' &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.searchParams.get('cloudAgentSessionId') === chat.cloudAgentSessionId &&
        url.searchParams.get('ptyId') === data.ptyId &&
        url.searchParams.has('ticket'),
      'PTY transport must target this local Worker and owned terminal'
    );
    url.protocol = url.protocol.replace(/^http/, 'ws');
    const ws = new WebSocket(url, {
      handshakeTimeout: 15_000,
      maxPayload: 256 * 1024,
      followRedirects: false,
    });
    let output = '';
    let broken = false;
    let closeCode: number | undefined;
    ws.on('error', () => {
      broken = true;
    });
    ws.on('close', code => {
      closeCode = code;
    });
    ws.on('message', raw => {
      const bytes = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      if (bytes[0] === 0) return;
      output += bytes.toString('utf8');
      if (output.length > 256 * 1024) {
        broken = true;
        ws.terminate();
      }
    });
    const terminate = () => ws.terminate();
    signal.addEventListener('abort', terminate, { once: true });
    async function received(marker: string) {
      await until('Reverse PTY output', 15_000, signal, async () => {
        check(!broken && closeCode === undefined, 'Reverse PTY ended before its output proof');
        return output.includes(marker) ? true : undefined;
      });
    }
    try {
      await until('Reverse PTY ready', 15_000, signal, async () => {
        check(!broken && closeCode === undefined, 'Reverse PTY connection failed');
        return ws.readyState === WebSocket.OPEN ? true : undefined;
      });
      ws.send(`printf '\\n%s%s\\n' 'onprem-pty-' '${runId}'\r`);
      await received(`onprem-pty-${runId}`);
      terminal.marker = `onprem-pty-${runId}`;
      const rows = 37;
      const cols = 113;
      const resized = parse(
        z.object({ pty: z.object({ id: idSchema, status: z.literal('running') }) }),
        await rpc('web', `${ORG}.resizeTerminal`, {
          organizationId: config.organizationId,
          cloudAgentSessionId: chat.cloudAgentSessionId,
          ptyId: data.ptyId,
          rows,
          cols,
        }),
        'PTY resize'
      );
      check(resized.pty.id === data.ptyId, 'Resized a different PTY');
      ws.send(`s=$(stty size); printf '\\n%s%s:%s\\n' 'onprem-size-' '${runId}' "$s"\r`);
      await received(`onprem-size-${runId}:${rows} ${cols}`);
      terminal.resize = { rows, cols };
      await closeTerminal();
      await until('Reverse PTY close', 15_000, signal, async () =>
        closeCode === undefined ? undefined : true
      );
      check(closeCode === 1000, 'Reverse PTY did not close normally');
      terminal.closeCode = closeCode;
      persist();
    } finally {
      signal.removeEventListener('abort', terminate);
      terminate();
    }
  }
  persist();
  try {
    await phase('preflight', async () => {
      check(
        process.env.NODE_ENV !== 'production' &&
          process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' &&
          process.env.NODE_USE_ENV_PROXY !== '1',
        'Local development with verified TLS and direct transports is required'
      );
      const worker = parseEnv(
        readFileSync(resolve(ROOT, 'services/cloud-agent-next/.dev.vars'), 'utf8')
      );
      const web = parseEnv(readFileSync(resolve(ROOT, 'apps/web/.env.development.local'), 'utf8'));
      check(
        worker.VERCEL_SANDBOX_ORG_IDS?.trim() === '' &&
          worker.BYOC_VERCEL_ORG_IDS?.trim() === '' &&
          !worker.VERCEL_TOKEN?.trim() &&
          !worker.KILOCODE_TOKEN_OVERRIDE?.trim() &&
          !worker.KILOCODE_ORG_ID_OVERRIDE?.trim() &&
          worker.LOG_REJECTED_KILO_URLS !== '1',
        'Remote compute must be explicitly disabled; no credential overrides or unsafe URL logging'
      );
      const enrolled = (worker.CONTROL_PLANE_IDS ?? '').split(',').map(value => value.trim());
      check(
        enrolled.some(
          value => value === '*' || value === config.organizationId || value === auth.userId
        ),
        'Existing fixture must be enrolled for control-plane sessions'
      );
      for (const [name, target, path] of [
        ['WORKER_URL', 'worker', '/'],
        ['KILOCODE_BACKEND_BASE_URL', 'web', '/'],
        ['KILO_OPENROUTER_BASE', 'web', '/api'],
        ['KILO_SESSION_INGEST_URL', 'ingest', '/'],
      ] as const) {
        const url = localUrl(worker[name] ?? '', `Worker ${name}`, true);
        check(
          url.origin === config.base[target] &&
            url.pathname.replace(/\/$/, '') === path.replace(/\/$/, ''),
          'Worker local routing differs from the explicit service targets'
        );
      }
      check(
        localUrl(web.FAKE_LLM_URL ?? '', 'Next fake routing').origin === config.base.fake,
        'Next must route the fake model to the supplied local fake server'
      );
      inspector = kubernetesInspector({ ...config, signal });
      const fixtures = inspector.config.localFixtureUpstreams;
      check(
        fixtures,
        'Installed localFixtureUpstreams.github.com is required; no public GitHub fallback'
      );
      for (const fixture of Object.values(fixtures)) {
        if (fixture === undefined) continue;
        check(
          localUrl(fixture, 'Installed GitHub fixture', true).pathname === '/',
          'GitHub fixture mapping must be a local origin'
        );
      }
      check(
        localUrl(fixtures['github.com'], 'Installed clone fixture', true).origin ===
          config.fixtureOrigin,
        'Installed clone fixture differs from --git-fixture-origin'
      );
      check(
        localUrl(inspector.config.cloudUrl, 'Installed cloud transport', true).origin ===
          config.base.worker,
        'Installed provisioner points at another Worker'
      );
      for (const [name, target] of [
        ['backendBaseUrl', 'web'],
        ['providerBaseUrl', 'web'],
        ['sessionIngestBaseUrl', 'ingest'],
      ] as const) {
        check(
          localUrl(inspector.config.upstreams[name], `Installed ${name}`, true).origin ===
            config.base[target],
          'Installed broker upstream differs from the local stack'
        );
      }
      const who = parse(
        z.object({ id: idSchema, is_admin: z.literal(false) }),
        await http('web', '/api/user'),
        'Native non-admin Kilo user'
      );
      check(who.id === auth.userId, 'Native Bearer identity differs from auth fixture userId');
      parse(
        z.object({ status: z.literal('ok') }),
        await http('worker', '/health'),
        'Local Worker health'
      );
      parse(
        z.object({ chatCompletions: z.number().int().nonnegative() }),
        await http('fake', '/test/requests'),
        'Local fake server'
      );
      const selection = parse(
        onPremStatusSchema,
        await rpc(
          'web',
          'organizations.onPremCompute.getStatus',
          { organizationId: config.organizationId },
          'GET'
        ),
        'Authenticated organization compute selection'
      );
      const installed = selection.installation;
      preflight = {
        selected: selection.selected,
        installationId: installed?.id,
        state: installed?.state,
        runtimeClass: installed?.profile?.runtimeClass,
        image: installed?.profile?.image,
        kubeServer: inspector.server,
        systemNamespace: config.systemNamespace,
        sandboxNamespace: inspector.config.sandboxNamespace,
        modelGateway: config.base.web,
        localGitFixture: new URL(new URL(config.gitUrl).pathname, config.fixtureOrigin).href,
        logicalRepository: config.gitUrl,
        upstreamBranch: config.branch,
        auth: 'native-user-bearer',
        globalAdmin: who.is_admin,
        createdOnPlatform: 'cloud-agent-web',
        prepareOnly: false,
      };
      persist();
      check(
        selection.selected &&
          installed?.id === config.installationId &&
          installed.organizationId === config.organizationId &&
          installed.state === 'ready' &&
          !installed.cleanupPending &&
          installed.profile?.runtimeClass === config.runtimeClass &&
          installed.profile.image === config.image &&
          installed.profile.id === inspector.config.profile.id &&
          installed.profile.revision === inspector.config.profile.revision &&
          installed.profile.brokerUrl === inspector.config.profile.brokerUrl &&
          inspector.config.profile.runtimeClass === config.runtimeClass &&
          inspector.config.profile.image === config.image,
        'Selected installation/profile does not match the prepared local MVP'
      );
    });
    const coldMarker = `onprem-cold-${runId}`;
    const warmMarker = `onprem-warm-${runId}`;
    let first: Chat | undefined;
    let pod: OnPremIdentity | undefined;
    await phase('cold', async () => {
      const cold = newTurn('cold', { write: coldMarker });
      const created = await rpc('worker', 'start', {
        message: { id: cold.messageId, prompt: cold.prompt },
        agent: { mode: 'code', model: MODEL },
        repository: { type: 'git', url: config.gitUrl, branch: config.branch },
        finalization: { autoCommit: false },
        options: {
          createdOnPlatform: 'cloud-agent-web',
          kilocodeOrganizationId: config.organizationId,
        },
      });
      first = { ...parse(sessionSchema, created, 'New workspace'), label: 'first' };
      chats.push(first);
      cold.chat = first;
      persist();
      const ack = parse(
        z.object({
          messageId: z.string().regex(MESSAGE_ID_PATTERN),
          delivery: z.enum(['sent', 'queued']),
        }),
        created,
        'Start admission'
      );
      check(ack.messageId === cold.messageId, 'Initial admission identity mismatch');
      const snapshot = await metadata(first);
      check(snapshot.initialMessageId === cold.messageId, 'Initial metadata message mismatch');
      await gate(cold);
      pod = await identity(first, 'cold-held');
      await release(cold);
      await settle(cold);
      await transcript(cold);
    });
    check(first && pod, 'Cold proof did not produce a reconciled workspace/Pod');
    const source = first;
    const original = pod;
    await phase('warm', async () => {
      await metadata(source);
      const warm = newTurn('warm', { read: coldMarker, replacement: warmMarker });
      await send(source, warm);
      await gate(warm);
      await identity(source, 'warm-held', original);
      await release(warm);
      await settle(warm);
      await transcript(warm);
      await identity(source, 'warm-completed', original);
    });
    await phase('reverse-pty', async () => {
      await pty(source);
      await identity(source, 'pty-closed', original);
    });
    await phase('sibling-stop', async () => {
      await metadata(source);
      if (!source.worktreeId) {
        const entry = phases.find(value => value.name === 'sibling-stop');
        check(entry, 'Missing sibling phase');
        entry.status = 'blocked';
        entry.detail =
          'Public web prepareSession with autoInitiate and operationKey can create worktree metadata without githubIntegrationId, but onprem GitHub bootstrap requires a managed installation token; there is no anonymous fallback. Public session-ingest creates only unscoped placeholders, and worktree registration is internal. Next choice: parent prepares an isolated local managed-GitHub integration and synthetic repo-token cache fixture with all GitHub App credentials absent, then explicitly switch creation to web prepare. Until that fixture is approved, sibling/Stop remains blocked; no internal-auth workaround or weaker pass criteria.';
        return;
      }
      const operationKey = randomUUID();
      const sibling: Chat = {
        ...parse(
          sessionSchema,
          await rpc('web', `${ORG}.createWorktreeChat`, {
            organizationId: config.organizationId,
            sourceKiloSessionId: source.kiloSessionId,
            operationKey,
          }),
          'Sibling creation'
        ),
        label: 'sibling',
      };
      chats.push(sibling);
      persist();
      check(
        sibling.kiloSessionId !== source.kiloSessionId &&
          sibling.cloudAgentSessionId !== source.cloudAgentSessionId &&
          sibling.worktreeId === source.worktreeId,
        'Sibling worktree identity mismatch'
      );
      await metadata(sibling);
      check(sibling.sandboxId === source.sandboxId, 'Sibling did not inherit the allocation');
      await identity(sibling, 'sibling-before-work', original);
      const stopped = newTurn('stopped', {}, 'interrupted');
      await send(source, stopped);
      await gate(stopped);
      const continuing = newTurn('sibling', {
        read: warmMarker,
        replacement: `onprem-sibling-${runId}`,
      });
      await send(sibling, continuing);
      await gate(continuing);
      check((await result(stopped)).status === 'running', 'First chat is not active at Stop');
      const interrupted = parse(
        z.object({ success: z.boolean() }),
        await rpc('web', `${ORG}.interruptSession`, {
          organizationId: config.organizationId,
          sessionId: source.cloudAgentSessionId,
        }),
        'Stop acknowledgment'
      );
      check(interrupted.success, 'Stop rejected');
      await settle(stopped);
      await transcript(stopped);
      await until('Stopped fake request disconnected', 15_000, signal, async () => {
        const state = parse(
          z.object({ engaged: z.boolean() }),
          await http('fake', `/test/gate-status?tag=${stopped.tag}`),
          'Stopped gate'
        );
        return state.engaged ? undefined : true;
      });
      check(
        (await result(continuing)).status === 'running' &&
          parse(
            z.object({ engaged: z.boolean() }),
            await http('fake', `/test/gate-status?tag=${continuing.tag}`),
            'Sibling held after Stop'
          ).engaged,
        'Sibling was interrupted by the other chat Stop'
      );
      await identity(sibling, 'sibling-after-stop', original);
      await release(continuing);
      await settle(continuing);
      await transcript(continuing);
      await identity(sibling, 'sibling-completed', original);
    });
    for (const turn of turns)
      check((await result(turn)).status === turn.expected, 'Prior message outcome changed');
    if (status === 'running') status = 'passed';
  } catch (error) {
    status = 'failed';
    failure =
      error instanceof CheckError
        ? error.message
        : 'Driver/configuration/filesystem failure; raw details omitted';
    const cold = turns.find(turn => turn.label === 'cold');
    const returned = mutations.find(
      mutation => mutation.operation === 'worker:/trpc/start'
    )?.returned;
    if (cold && !cold.chat && returned?.cloudAgentSessionId && !signal.aborted) {
      try {
        const snapshot = parse(
          snapshotSchema,
          await rpc(
            'worker',
            'getSession',
            { cloudAgentSessionId: returned.cloudAgentSessionId },
            'GET'
          ),
          'Read-only start reconciliation'
        );
        check(
          snapshot.initialMessageId === cold.messageId &&
            snapshot.userId === auth.userId &&
            snapshot.orgId === config.organizationId,
          'Start reconciliation identity mismatch'
        );
        const chat: Chat = {
          cloudAgentSessionId: snapshot.sessionId,
          kiloSessionId: snapshot.kiloSessionId,
          sandboxId: snapshot.sandboxId,
          label: 'first',
        };
        cold.chat = chat;
        chats.push(chat);
        persist();
      } catch {
        reconciliations.push({
          messageId: cold.messageId,
          status: 'returned-start-identity-unconfirmed',
        });
      }
    }
    for (const turn of turns) {
      if (!turn.chat || signal.aborted) continue;
      try {
        reconciliations.push({ messageId: turn.messageId, result: await result(turn) });
      } catch {
        reconciliations.push({
          messageId: turn.messageId,
          status: 'read-only-reconciliation-unavailable',
        });
      }
    }
    if (turns.some(turn => !turn.chat))
      reconciliations.push({
        status: 'initial-identity-unresolved',
        action:
          'Use the persisted requested message ID and returned IDs to reconcile local ownership; do not rerun start. The public API has no lookup by start message ID.',
      });
  } finally {
    if (terminal && !terminal.closeAttempted) {
      try {
        await closeTerminal(true);
      } catch {
        reconciliations.push({
          ptyId: terminal.ptyId,
          status: 'pty-close-unconfirmed-do-not-replay',
        });
        status = 'failed';
      }
    }
    for (const turn of turns) {
      if (turn.releaseAttempted) continue;
      try {
        const held = parse(
          z.object({ engaged: z.boolean() }),
          await http('fake', `/test/gate-status?tag=${turn.tag}`, 'GET', undefined, true),
          'Owned gate cleanup'
        );
        if (held.engaged) await release(turn, true);
      } catch {
        reconciliations.push({ tag: turn.tag, status: 'gate-cleanup-unconfirmed' });
        status = 'failed';
      }
    }
    persist();
  }
  const finalStatus = reportedStatus();
  console.log(
    `${finalStatus.toUpperCase()}: ${phases.filter(value => value.status === 'passed').length}/${phases.length} focused scenarios; evidence ${evidence.path}/evidence.json; disconnect/revocation/isolation NOT RUN`
  );
  process.exitCode = finalStatus === 'passed' ? 0 : finalStatus === 'blocked' ? 2 : 1;
}

async function main() {
  const config = options();
  if (!config) return;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const deadline = setTimeout(stop, 20 * 60_000);
  try {
    await run(config, controller.signal);
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

void main().catch(error => {
  console.error(
    error instanceof CheckError
      ? error.message
      : 'Onprem runner failed before evidence could be saved; raw details omitted. No mutation replayed.'
  );
  process.exitCode = 1;
});
