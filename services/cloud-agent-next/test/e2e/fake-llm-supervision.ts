import type { ScenarioHandler } from './fake-llm-core.js';

type Message = { role?: unknown; content?: unknown; tool_call_id?: unknown };

function messages(body: unknown): Message[] {
  if (typeof body !== 'object' || body === null || !('messages' in body)) return [];
  if (!Array.isArray(body.messages)) return [];
  return body.messages.filter(
    (message): message is Message => typeof message === 'object' && message !== null
  );
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part: unknown) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : []
    )
    .join('\n');
}

/**
 * Goal fixtures use real native continuation after one successful bootstrap tool.
 * Stages come from the model conversation, so retries do not advance a counter.
 * This is test-model behavior only; production supervision never reads goals.
 */
export const supervisionScenario: ScenarioHandler = (args, ctx) => {
  const parsed = /^([A-Za-z0-9_-]{1,64}):(progress|stuck|silent):(\d+)(?=\s|$)/.exec(args[0] ?? '');
  if (!parsed) {
    ctx.emit.json(400, { error: 'expected supervision:<tag>:<progress|stuck|silent>:<seconds>' });
    return;
  }
  const [, tag, mode, rawSeconds] = parsed;
  const seconds = Number(rawSeconds);
  // Native bash has a ten-minute maximum; leave room for normal completion.
  const maximum = mode === 'silent' ? 540 : 1800;
  if (seconds < 1 || seconds > maximum) {
    ctx.emit.json(400, { error: `supervision duration must be between 1 and ${maximum} seconds` });
    return;
  }
  const history = messages(ctx.body);
  const bootstrapId = `supervision_${tag}_bootstrap`;
  const workId = `supervision_${tag}_work`;
  const reportId = `supervision_${tag}_report`;
  const hasResult = (id: string) =>
    history.some(message => message.role === 'tool' && message.tool_call_id === id);
  const bootstrapReplyIndex = history.findLastIndex(
    message =>
      message.role === 'assistant' && text(message.content).includes(`supervision-bootstrap-${tag}`)
  );
  const continuation =
    bootstrapReplyIndex >= 0 &&
    history.findLastIndex(message => message.role === 'user') > bootstrapReplyIndex;

  function chunk(delta: unknown, finish: string | null = null): void {
    ctx.emit.sse({
      id: ctx.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  }

  function finish(reason = 'stop'): void {
    chunk({}, reason);
    ctx.emit.done();
    ctx.emit.end();
  }

  function reply(value: string): void {
    chunk({ role: 'assistant', content: value });
    finish();
  }

  function tool(name: string, id: string, input: Record<string, unknown>): void {
    if (!ctx.tools.some(advertised => advertised.name === name)) {
      ctx.emit.json(422, { error: `supervision fixture requires native ${name}` });
      return;
    }
    chunk({
      role: 'assistant',
      tool_calls: [
        { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } },
      ],
    });
    finish('tool_calls');
  }

  const complete = () =>
    tool('goal_report', reportId, { status: 'complete', reason: `Fixture ${tag} finished` });

  if (hasResult(reportId)) return reply(`supervision-complete-${tag}`);
  if (!continuation) {
    if (hasResult(bootstrapId)) return reply(`supervision-bootstrap-${tag}`);
    return tool('bash', bootstrapId, {
      command: 'printf supervision-bootstrap',
      description: 'Establish concrete work before native goal continuation',
    });
  }
  if (mode === 'silent') {
    if (hasResult(workId)) return complete();
    return tool('bash', workId, {
      command: `sleep ${seconds}`,
      timeout: (seconds + 30) * 1000,
      description: `Bounded silent supervision fixture ${tag}`,
    });
  }

  if (mode === 'progress') {
    // Keep model requests short: the gateway bounds each one at ten minutes.
    // Native tools provide the long-running work between progress updates.
    const stepSeconds = Math.min(240, Math.ceil(seconds / 3));
    for (let elapsed = 0, step = 0; elapsed < seconds; elapsed += stepSeconds, step++) {
      const id = `${workId}_${step}`;
      if (hasResult(id)) continue;
      const duration = Math.min(stepSeconds, seconds - elapsed);
      chunk({ content: `supervision-progress-${tag}\n` });
      return tool('bash', id, {
        command: `sleep ${duration}; printf supervision-progress-${tag}`,
        timeout: (duration + 30) * 1000,
        description: `Bounded progress step ${step + 1} for ${tag}`,
      });
    }
    chunk({ content: `supervision-progress-${tag}\n` });
    return complete();
  }

  // Native cancellation can leave its upstream request open. Bound this hold
  // independently and release it on HTTP closure or the fake server's teardown.
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  ctx.state.liveResponses.add(ctx.emit);
  const cleanup = () => {
    closed = true;
    clearTimeout(timer);
    ctx.state.liveResponses.delete(ctx.emit);
  };
  ctx.emit.onClose(cleanup);
  if (closed) return;
  ctx.emit.start();
  const end = Date.now() + seconds * 1000;
  function next(): void {
    if (closed) return;
    if (Date.now() >= end) {
      cleanup();
      complete();
      return;
    }
    timer = setTimeout(next, Math.min(30_000, end - Date.now()));
  }
  next();
};
