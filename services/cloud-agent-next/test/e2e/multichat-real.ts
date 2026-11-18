import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createMessageId } from '../../src/session/message-id.js';
import {
  CheckError,
  MODEL,
  RpcHttpError,
  assertNativeHoldOverlap,
  assertNoNativeCompletion,
  hasNativeCancellation,
  matchesNativeHold,
  runningNativeHold,
  check,
  messageSchema,
  observe,
  parse,
  partSchema,
  rpc,
  sessionSchema,
  setup,
  until,
  type Chat,
  type NativeHold,
  type Observer,
  type Part,
  type Runtime,
} from './multichat-real-support.js';

const resultSchema = z.object({
  cloudAgentSessionId: z.string(),
  messageId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
  failure: z.unknown().optional(),
});
const transcriptSchema = z.object({
  info: z.object({ id: z.string() }),
  messages: z.array(z.object({ info: messageSchema, parts: z.array(partSchema) })),
});
type Turn = {
  chat: Chat;
  messageId: string;
  tag: string;
  prompt: string;
  expected: 'completed' | 'interrupted';
  marker: string;
  write: boolean;
  admittedAt?: number;
  hold?: NativeHold;
  stop?: { hold: NativeHold; sequence: number; requestedAt: number };
  result?: z.infer<typeof resultSchema>;
};

function fileTool(part: Part, tool: 'read' | 'write', filename: string, marker: string): boolean {
  const path = part.state?.input?.filePath;
  return (
    part.tool === tool &&
    part.state?.status === 'completed' &&
    typeof path === 'string' &&
    (path === filename || path.endsWith(`/${filename}`)) &&
    (tool === 'write'
      ? part.state.input?.content === `${marker}\n`
      : part.state.output?.includes(marker) === true)
  );
}

async function run(runtime: Runtime, rounds: number, turnTimeoutMs: number) {
  const runId = randomUUID();
  const filename = `multichat-real-${runId}.txt`;
  const observers = new Map<string, Observer>();
  const chats: Chat[] = [];
  const turns: Turn[] = [];
  const phases: { name: string; status: 'running' | 'passed' | 'failed' }[] = [];
  let status: 'running' | 'passed' | 'failed' = 'running';
  const limits = [
    'API-assisted public-Git bootstrap uses trusted Worker prepareSession and the generateCloudAgentToken claim shape, minted from verified local personal fixture claims with a maximum one-hour lifetime; not browser repository selection.',
    'Sibling creation, follow-ups and Stop use real personal web tRPC routes and real kilo-auto/efficient inference; no balance bypass.',
    'Streams start after initial IDs are minted; initial evidence may be replayed. Follow-up observers are ready before submission.',
    'Fresh worktree plus immediate follow-ups; no forced idle, sandbox loss, provider replacement, or physical identity assertions.',
    'Native 180-second writer and 120-second reader holds must overlap in live state and persisted intervals for at least one second; missed overlap fails without retry.',
    'Stop requires a post-request error/cancellation for the captured native hold; event and transcript audits continue through other work and the full 180-second hold duration plus 30 seconds after Stop.',
    'Browser reload, UI controls, orgs, private git credentials and billing attribution inspection remain operator coverage.',
    'Only owned observers are closed. Chats, files and sandboxes remain for the primary operator; no cleanup or resumption mutations.',
  ];
  function persist() {
    runtime.save('report.json', {
      runId,
      model: MODEL,
      status,
      filename,
      userId: runtime.auth.userId,
      rounds,
      turnTimeoutMs,
      chats,
      turns,
      phases,
      limits,
    });
  }
  async function phase<T>(name: string, action: () => Promise<T>): Promise<T> {
    const entry = { name, status: 'running' as 'running' | 'passed' | 'failed' };
    phases.push(entry);
    persist();
    try {
      const value = await action();
      entry.status = 'passed';
      persist();
      console.log(`${name}: passed`);
      return value;
    } catch (error) {
      entry.status = 'failed';
      throw error;
    }
  }
  function observer(chat: Chat) {
    const value = observers.get(chat.label);
    check(value, `${chat.label}: no ready observer`);
    value.healthy();
    return value;
  }
  function intent(
    chat: Chat,
    instruction: string,
    marker: string,
    write = false,
    expected: Turn['expected'] = 'completed'
  ) {
    const tag = `turn-${randomUUID()}`;
    const turn: Turn = {
      chat,
      messageId: createMessageId(),
      tag,
      prompt: `Request ${tag}. ${instruction} Do not delegate, commit, push, inspect credentials, or modify any other files.`,
      marker,
      write,
      expected,
    };
    turns.push(turn);
    persist();
    return turn;
  }
  async function send(
    chat: Chat,
    instruction: string,
    marker: string,
    write = false,
    expected: Turn['expected'] = 'completed'
  ) {
    observer(chat);
    const turn = intent(chat, instruction, marker, write, expected);
    const response = parse(
      z.object({
        cloudAgentSessionId: z.string(),
        messageId: z.string(),
        delivery: z.enum(['sent', 'queued']),
      }),
      await rpc(runtime, 'web', 'cloudAgentNext.sendMessage', {
        cloudAgentSessionId: chat.cloudAgentSessionId,
        messageId: turn.messageId,
        payload: { type: 'prompt', prompt: turn.prompt, mode: 'code', model: MODEL },
        autoCommit: false,
      }),
      'sendMessage'
    );
    check(
      response.messageId === turn.messageId &&
        response.cloudAgentSessionId === chat.cloudAgentSessionId,
      `${chat.label}: admission identity mismatch`
    );
    turn.admittedAt = Date.now();
    persist();
    return turn;
  }
  async function result(turn: Turn, remainingMs = 15_000) {
    const value = parse(
      resultSchema,
      await rpc(
        runtime,
        'worker',
        'getMessageResult',
        {
          cloudAgentSessionId: turn.chat.cloudAgentSessionId,
          messageId: turn.messageId,
        },
        'GET',
        Math.min(15_000, remainingMs)
      ),
      'getMessageResult'
    );
    check(
      value.messageId === turn.messageId &&
        value.cloudAgentSessionId === turn.chat.cloudAgentSessionId,
      `${turn.chat.label}: result identity mismatch`
    );
    if (turn.result?.status !== value.status) {
      turn.result = value;
      persist();
    }
    return value;
  }
  async function settle(turn: Turn) {
    const stream = observer(turn.chat);
    await until(
      `${turn.chat.label} ${turn.messageId} terminal`,
      turnTimeoutMs,
      runtime.signal,
      async remaining => {
        stream.healthy();
        const value = await result(turn, remaining);
        if (value.status === 'queued' || value.status === 'running') return undefined;
        check(
          value.status === turn.expected,
          `${turn.chat.label} ${turn.messageId}: expected ${turn.expected}, got ${value.status}`
        );
        const event = stream.terminals.get(turn.messageId);
        if (!event) return undefined;
        check(
          event.type ===
            (turn.expected === 'completed' ? 'cloud.message.completed' : 'cloud.message.failed'),
          `${turn.chat.label}: streamed terminal disagrees with durable result`
        );
        if (event.status)
          check(event.status === turn.expected, `${turn.chat.label}: streamed status mismatch`);
        return true;
      }
    );
  }
  async function all<T>(actions: Promise<T>[]): Promise<T[]> {
    const settled = await Promise.allSettled(actions);
    const failed = settled.find(item => item.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return settled.flatMap(item => (item.status === 'fulfilled' ? [item.value] : []));
  }
  function holdPrompt(seconds: number) {
    return `Then, as a separate foreground bash tool call, run exactly sleep ${seconds} with timeout ${(seconds + 60) * 1000} milliseconds. Wait for it to finish; do not background it. `;
  }
  function nativeStopObserved(turn: Turn) {
    check(turn.stop, 'Stopped turn is missing its native tool identity');
    const stream = observer(turn.chat);
    assertNoNativeCompletion(stream.nativeEvents(turn.messageId), turn.stop.hold);
    return (
      hasNativeCancellation(
        stream.nativeEvents(turn.messageId, turn.stop.sequence),
        turn.stop.hold
      ) &&
      hasNativeCancellation(
        {
          messages: stream.nativeEvents(turn.messageId).messages,
          tools: stream.tools(turn.messageId),
        },
        turn.stop.hold
      )
    );
  }
  function readPrompt(holdSeconds = 0) {
    return (
      `Use the read tool to read ${filename} in the repository root NOW. Do not guess its contents from conversation history. ` +
      (holdSeconds ? holdPrompt(holdSeconds) : '') +
      'Reply with the exact file contents you read. Do not create or modify files.'
    );
  }
  async function transcript(chat: Chat) {
    return until(`${chat.label} transcript audit`, 90_000, runtime.signal, async remaining => {
      const response = await fetch(
        new URL(`/api/session/${chat.kiloSessionId}/export`, runtime.base.ingest),
        {
          headers: { Authorization: `Bearer ${runtime.auth.token}` },
          redirect: 'error',
          signal: AbortSignal.any([
            runtime.signal,
            AbortSignal.timeout(Math.max(1, Math.min(15_000, remaining))),
          ]),
        }
      );
      check(response.ok, `${chat.label}: export HTTP ${response.status}`);
      const data: unknown = await response.json();
      runtime.save(`${chat.label}-export.json`, data);
      const parsed = transcriptSchema.safeParse(data);
      if (!parsed.success) return undefined;
      const exported = parsed.data;
      check(
        exported.info.id === chat.kiloSessionId,
        `${chat.label}: export root identity mismatch`
      );
      const ids = new Set<string>();
      const partIds = new Set<string>();
      const ownTurns = turns.filter(turn => turn.chat.label === chat.label);
      const foreignTurns = turns.filter(turn => turn.chat.label !== chat.label);
      for (const message of exported.messages) {
        check(!ids.has(message.info.id), `${chat.label}: duplicate native message ID`);
        ids.add(message.info.id);
        check(
          message.info.sessionID === chat.kiloSessionId,
          `${chat.label}: foreign transcript message`
        );
        check(
          !foreignTurns.some(
            turn => turn.messageId === message.info.id || turn.messageId === message.info.parentID
          ),
          `${chat.label}: sibling message leaked into transcript`
        );
        const text = message.parts
          .filter(part => part.type === 'text')
          .map(part => part.text ?? '')
          .join('\n');
        check(
          !foreignTurns.some(turn => text.includes(turn.tag)),
          `${chat.label}: sibling request text leaked`
        );
        if (message.info.role === 'user') {
          check(
            ownTurns.some(turn => turn.messageId === message.info.id),
            `${chat.label}: unexpected user message (possible duplicate admission)`
          );
        } else {
          check(
            ownTurns.some(turn => turn.messageId === message.info.parentID),
            `${chat.label}: orphan assistant message`
          );
        }
        for (const part of message.parts) {
          check(!partIds.has(part.id), `${chat.label}: duplicate native part ID`);
          partIds.add(part.id);
          check(
            part.sessionID === chat.kiloSessionId && part.messageID === message.info.id,
            `${chat.label}: part identity mismatch`
          );
        }
      }
      for (const turn of ownTurns) {
        const user = exported.messages.find(
          message => message.info.id === turn.messageId && message.info.role === 'user'
        );
        if (
          !user ||
          !user.parts.some(part => part.type === 'text' && part.text?.includes(turn.prompt))
        )
          return undefined;
        const assistants = exported.messages.filter(
          message => message.info.role === 'assistant' && message.info.parentID === turn.messageId
        );
        const parts = assistants.flatMap(message => message.parts);
        if (turn.expected === 'interrupted') {
          check(turn.stop, 'Interrupted turn has no saved native Stop identity');
          const cancelled = hasNativeCancellation(
            { messages: assistants.map(message => message.info), tools: parts },
            turn.stop.hold
          );
          if (
            !nativeStopObserved(turn) ||
            !cancelled ||
            !parts.some(part => fileTool(part, 'read', filename, turn.marker))
          )
            return undefined;
          continue;
        }
        check(
          !assistants.some(message => message.info.error),
          `${chat.label}: assistant error in successful turn`
        );
        check(
          !parts.some(part => part.type === 'tool' && part.state?.status === 'error'),
          `${chat.label}: failed tool in successful turn`
        );
        if (
          !assistants.some(
            message =>
              message.info.time?.completed &&
              message.parts.some(
                part => part.type === 'text' && !part.synthetic && part.text?.includes(turn.marker)
              )
          )
        )
          return undefined;
        if (!parts.some(part => fileTool(part, 'read', filename, turn.marker))) return undefined;
        if (turn.write && !parts.some(part => fileTool(part, 'write', filename, turn.marker)))
          return undefined;
      }
      runtime.record('audits.jsonl', {
        chat: chat.label,
        kiloSessionId: chat.kiloSessionId,
        messages: ids.size,
        parts: partIds.size,
        turns: ownTurns.length,
        passed: true,
      });
      return exported;
    });
  }
  async function waitForHolds(entries: { turn: Turn; seconds: number }[], label: string) {
    const holds = await until(label, turnTimeoutMs, runtime.signal, async remaining => {
      const values = await all(entries.map(({ turn }) => result(turn, remaining)));
      check(
        values.every(value => value.status === 'queued' || value.status === 'running'),
        `${label}: turn terminalized before native overlap`
      );
      const observed = entries.map(({ turn, seconds }) => {
        const parts = observer(turn.chat).tools(turn.messageId);
        const hold = turn.hold ?? runningNativeHold(parts, seconds);
        if (!hold) return undefined;
        const active = parts.find(part => matchesNativeHold(part, hold));
        check(
          active?.state?.status === 'running',
          `${label}: captured native hold ended before overlap`
        );
        const read = parts.find(part => fileTool(part, 'read', filename, turn.marker));
        if (read?.state?.time?.end === undefined || read.state.time.end > hold.startedAt)
          return undefined;
        if (turn.write) {
          const write = parts.find(part => fileTool(part, 'write', filename, turn.marker));
          if (write?.state?.time?.end === undefined || write.state.time.end > hold.startedAt)
            return undefined;
        }
        return hold;
      });
      if (values.some(value => value.status !== 'running') || observed.some(hold => !hold))
        return undefined;
      return observed.filter((hold): hold is NativeHold => hold !== undefined);
    });
    entries.forEach(({ turn }, index) => {
      turn.hold = holds[index];
    });
    persist();
    runtime.record('barriers.jsonl', {
      label,
      holds,
      messageIds: entries.map(({ turn }) => turn.messageId),
    });
  }
  async function sibling(source: Chat, label: string) {
    const created = parse(
      sessionSchema,
      await rpc(runtime, 'web', 'cloudAgentNext.createWorktreeChat', {
        sourceKiloSessionId: source.kiloSessionId,
        operationKey: randomUUID(),
      }),
      'createWorktreeChat'
    );
    const chat = { ...created, label };
    chats.push(chat);
    persist();
    check(
      chat.worktreeId === source.worktreeId && chat.worktreeId,
      `${label}: sibling worktree mismatch`
    );
    check(
      chats.filter(
        other =>
          other.kiloSessionId === chat.kiloSessionId ||
          other.cloudAgentSessionId === chat.cloudAgentSessionId
      ).length === 1,
      `${label}: duplicate chat identity`
    );
    observers.set(label, await observe(runtime, chat));
    return chat;
  }
  persist();
  try {
    const eligibility = parse(
      z.object({ balance: z.number(), isEligible: z.boolean() }),
      await rpc(runtime, 'web', 'cloudAgentNext.checkEligibility', undefined, 'GET'),
      'checkEligibility'
    );
    check(
      eligibility.isEligible && eligibility.balance >= 1,
      'Existing personal account must have at least $1; no account or balance is modified'
    );
    const marker = `shared-${randomUUID()}`;
    const writer = await phase('cold-writer', async () => {
      const operationKey = randomUUID();
      const messageId = createMessageId();
      const tag = `turn-${randomUUID()}`;
      const prompt = `Request ${tag}. Use the write tool to create ${filename} in the repository root containing exactly ${marker} followed by a newline. Use the read tool to read it back, then reply with its exact contents. Do not delegate, commit, push, inspect credentials, or modify other files.`;
      runtime.record('initial-intent.jsonl', { operationKey, messageId, tag, prompt });
      const created = parse(
        sessionSchema,
        await rpc(
          runtime,
          'worker',
          'prepareSession',
          {
            prompt,
            initialMessageId: messageId,
            operationKey,
            mode: 'code',
            model: MODEL,
            gitUrl: 'https://github.com/octocat/Hello-World.git',
            shallow: true,
            createdOnPlatform: 'cloud-agent-web',
            clientProvenance: 'browser',
            autoInitiate: true,
            autoCommit: false,
          },
          'POST',
          90_000,
          true
        ),
        'prepareSession'
      );
      const chat: Chat = { ...created, label: 'writer' };
      chats.push(chat);
      const turn: Turn = {
        chat,
        messageId,
        tag,
        prompt,
        marker,
        write: true,
        expected: 'completed',
        admittedAt: Date.now(),
      };
      turns.push(turn);
      persist();
      const snapshot = parse(
        z.object({
          kiloSessionId: z.string(),
          initialMessageId: z.string(),
        }),
        await rpc(
          runtime,
          'worker',
          'getSession',
          { cloudAgentSessionId: chat.cloudAgentSessionId },
          'GET'
        ),
        'getSession'
      );
      check(
        snapshot.kiloSessionId === chat.kiloSessionId && snapshot.initialMessageId === messageId,
        'Initial Worker session identity mismatch'
      );
      observers.set(chat.label, await observe(runtime, chat));
      chat.worktreeId = await until(
        'Authoritative web worktree ownership',
        90_000,
        runtime.signal,
        async remaining => {
          observer(chat);
          let data: unknown;
          try {
            data = await rpc(
              runtime,
              'web',
              'cliSessionsV2.get',
              { session_id: chat.kiloSessionId },
              'GET',
              Math.min(15_000, remaining)
            );
          } catch (error) {
            if (error instanceof RpcHttpError && error.status === 404) return undefined;
            throw error;
          }
          const session = parse(
            z.object({
              session_id: z.string(),
              kilo_user_id: z.string(),
              organization_id: z.null(),
              cloud_agent_session_id: z.string().nullable(),
              cloud_agent_worktree_id: z.string().min(1).nullable(),
            }),
            data,
            'cliSessionsV2.get'
          );
          check(
            session.session_id === chat.kiloSessionId &&
              session.kilo_user_id === runtime.auth.userId,
            'Initial web session ownership mismatch'
          );
          check(
            session.cloud_agent_session_id === null ||
              session.cloud_agent_session_id === chat.cloudAgentSessionId,
            'Initial web Cloud Agent identity mismatch'
          );
          if (!session.cloud_agent_session_id || !session.cloud_agent_worktree_id) return undefined;
          return session.cloud_agent_worktree_id;
        }
      );
      persist();
      await settle(turn);
      await transcript(chat);
      return chat;
    });
    await phase('warm-writer-followup', async () => {
      await settle(await send(writer, readPrompt(), marker));
      await transcript(writer);
    });
    const readers: Chat[] = [];
    for (const label of ['reader-b', 'reader-c']) {
      readers.push(
        await phase(`serial-${label}`, async () => {
          const chat = await sibling(writer, label);
          await settle(await send(chat, readPrompt(), marker));
          await transcript(chat);
          return chat;
        })
      );
    }
    let latestMarker = marker;
    for (let round = 1; round <= rounds; round++) {
      await phase(`overlap-${round}`, async () => {
        latestMarker = `shared-${randomUUID()}`;
        const writing = await send(
          writer,
          `Use the write tool to replace ${filename} in the repository root with exactly ${latestMarker} followed by a newline. Use the read tool to read it back. ${holdPrompt(180)}Reply with the exact contents.`,
          latestMarker,
          true
        );
        await waitForHolds(
          [{ turn: writing, seconds: 180 }],
          'successful-write-and-active-writer-hold-before-readers'
        );
        const reading = await all(readers.map(chat => send(chat, readPrompt(120), latestMarker)));
        const overlapping = [writing, ...reading];
        await waitForHolds(
          [{ turn: writing, seconds: 180 }, ...reading.map(turn => ({ turn, seconds: 120 }))],
          'three-native-holds-active'
        );
        await all(overlapping.map(settle));
        const heldParts = await all(
          overlapping.map(async turn => {
            const history = await transcript(turn.chat);
            const hold = turn.hold;
            check(hold, 'Overlap has no captured native hold');
            const part = history.messages
              .filter(message => message.info.parentID === turn.messageId)
              .flatMap(message => message.parts)
              .find(part => matchesNativeHold(part, hold));
            check(part, 'Captured overlap hold is missing from persisted transcript');
            return part;
          })
        );
        runtime.record('barriers.jsonl', {
          label: 'persisted-native-hold-overlap',
          ...assertNativeHoldOverlap(heldParts),
          partIds: heldParts.map(part => part.id),
        });
      });
    }
    await phase('stop-one-sibling-continues', async () => {
      const survivor = readers[0];
      check(survivor, 'Missing sibling');
      const [stopped, continuing] = await all([
        send(writer, readPrompt(180), latestMarker, false, 'interrupted'),
        send(survivor, readPrompt(180), latestMarker),
      ]);
      check(stopped && continuing, 'Missing admitted stop turns');
      await waitForHolds(
        [stopped, continuing].map(turn => ({ turn, seconds: 180 })),
        'both-native-holds-active-before-stop'
      );
      check(stopped.hold && continuing.hold, 'Stop requires captured native hold identities');
      stopped.stop = {
        hold: stopped.hold,
        sequence: observer(writer).sequence(),
        requestedAt: Date.now(),
      };
      persist();
      const interrupted = parse(
        z.object({ success: z.boolean() }),
        await rpc(runtime, 'web', 'cloudAgentNext.interruptSession', {
          sessionId: writer.cloudAgentSessionId,
        }),
        'interruptSession'
      );
      check(interrupted.success, 'Stop was rejected');
      await settle(stopped);
      await until('Exact native hold cancellation after Stop', 90_000, runtime.signal, async () =>
        nativeStopObserved(stopped) ? true : undefined
      );
      const continuingHold = continuing.hold;
      check(
        (await result(continuing)).status === 'running' &&
          observer(survivor)
            .tools(continuing.messageId)
            .some(
              part => matchesNativeHold(part, continuingHold) && part.state?.status === 'running'
            ),
        'Sibling native hold did not remain active after Stop'
      );
      runtime.record('barriers.jsonl', {
        label: 'sibling-running-after-stop',
        stopped: stopped.messageId,
        continuing: continuing.messageId,
      });
      await settle(continuing);
      await all([writer, survivor].map(transcript));
    });
    await phase('same-chat-followups-after-stop', async () => {
      const followups = await all(chats.map(chat => send(chat, readPrompt(), latestMarker)));
      await all(followups.map(settle));
      await all(chats.map(transcript));
      for (const turn of turns)
        check(
          (await result(turn)).status === turn.expected,
          'Prior terminal outcome changed after follow-up'
        );
    });
    await phase('native-stop-final-recheck', async () => {
      for (const turn of turns.filter(value => value.stop)) {
        const stop = turn.stop;
        check(stop, 'Missing native Stop evidence');
        const recheckAt = stop.requestedAt + (stop.hold.seconds + 30) * 1000;
        await until(
          'Observe beyond stopped hold natural duration',
          Math.max(1, recheckAt - Date.now()) + 5000,
          runtime.signal,
          async () => {
            check(
              nativeStopObserved(turn),
              'Native cancellation evidence disappeared after other work'
            );
            return Date.now() >= recheckAt ? true : undefined;
          }
        );
        await transcript(turn.chat);
        check(
          (await result(turn)).status === 'interrupted' && nativeStopObserved(turn),
          'Stopped turn did not remain natively cancelled'
        );
        runtime.record('audits.jsonl', {
          label: 'native-stop-final-recheck',
          messageId: turn.messageId,
          stop,
          passed: true,
        });
      }
    });
    for (const stream of observers.values()) stream.healthy();
    status = 'passed';
  } catch (error) {
    status = 'failed';
    runtime.record('failure.jsonl', {
      message:
        error instanceof CheckError
          ? error.message
          : 'Unexpected driver, export, or filesystem error; no mutation retried',
    });
    throw error;
  } finally {
    for (const stream of observers.values()) stream.close();
    persist();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      auth: { type: 'string' },
      out: { type: 'string' },
      rounds: { type: 'string', default: '3' },
      'turn-timeout-seconds': { type: 'string', default: '360' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm exec tsx services/cloud-agent-next/test/e2e/multichat-real.ts --auth <private-auth.json> [--out dev/logs/<NEW-directory>] [--rounds 3] [--turn-timeout-seconds 360]'
    );
    console.log(
      'Real paid local personal-account run; existing funded/enrolled account and active stack required. Discovers ports with dev:status. Never retries mutations or cleans sandboxes. Browser reload is manual.'
    );
    return;
  }
  check(values.auth, '--auth is required; token must not be passed on the command line');
  const rounds = Number(values.rounds);
  const timeoutSeconds = Number(values['turn-timeout-seconds']);
  check(Number.isInteger(rounds) && rounds >= 2 && rounds <= 5, '--rounds must be 2–5');
  check(
    Number.isInteger(timeoutSeconds) && timeoutSeconds >= 240 && timeoutSeconds <= 600,
    '--turn-timeout-seconds must be 240–600 to cover native holds'
  );
  const local = setup(values.auth, values.out ?? `dev/logs/multichat-real-${randomUUID()}`);
  console.log(`Private evidence: ${local.out}`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const timer = setTimeout(stop, 45 * 60_000);
  try {
    await run({ ...local, signal: controller.signal }, rounds, timeoutSeconds * 1000);
    console.log(`PASS: ${resolve(local.out, 'report.json')}`);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

void main().catch(error => {
  console.error(
    error instanceof CheckError
      ? error.message
      : 'Driver failed; inspect private evidence. No mutation was retried.'
  );
  process.exitCode = 1;
});
