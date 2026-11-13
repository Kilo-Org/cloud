import type { ScenarioHandler } from './fake-llm-core.js';

export const backgroundActivityScenario: ScenarioHandler = (args, ctx) => {
  const tag = /^([A-Za-z0-9_-]{1,48})(?=\s|$)/.exec(args[0] ?? '')?.[1];
  if (!tag) {
    ctx.emit.json(400, { error: 'expected background-activity:<tag>' });
    return;
  }
  const body = ctx.body;
  const history =
    typeof body === 'object' && body !== null && 'messages' in body && Array.isArray(body.messages)
      ? body.messages
      : [];
  const launched = history.some(
    (message: unknown) =>
      typeof message === 'object' &&
      message !== null &&
      'tool_call_id' in message &&
      message.tool_call_id === `activity_${tag}_shell`
  );
  const tools = [
    {
      name: 'shell',
      id: `activity_${tag}_shell`,
      input: {
        command: `for attempt in $(seq 1 180); do [ -f /tmp/activity-${tag}-release ] && break; sleep 0.5; done; printf 'Local shell output\\n'; exit 7`,
        description: 'Run background checks',
        background: true,
      },
    },
    {
      name: 'subagent',
      id: `activity_${tag}_agent`,
      input: {
        agent: 'explore',
        description: 'Inspect commands',
        prompt: `__fake__:gate:activity-child-${tag}:waiting`,
        background: true,
      },
    },
  ];
  if (
    !launched &&
    tools.some(tool => !ctx.tools.some(advertised => advertised.name === tool.name))
  ) {
    ctx.emit.json(422, {
      error: 'background activity fixture requires native shell and subagent tools',
    });
    return;
  }
  const chunk = (delta: unknown, finish: string | null = null) =>
    ctx.emit.sse({
      id: ctx.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  chunk(
    launched
      ? { role: 'assistant', content: 'Background work continues.' }
      : {
          role: 'assistant',
          tool_calls: tools.map((tool, index) => ({
            index,
            id: tool.id,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.input) },
          })),
        }
  );
  chunk({}, launched ? 'stop' : 'tool_calls');
  ctx.emit.done();
  ctx.emit.end();
};
