import type { ScenarioContext, ScenarioHandler } from './fake-llm-core.js';

type ToolCall = { name: string; id: string; input: Record<string, unknown> };

const CHILD_RESULT = [
  'The timeout comes from `uploadArtifact`. It uses a 30 s `AbortSignal`, but a large upload takes about 45 s.',
  '',
  '- Evidence: `services/release-worker/src/upload.ts:88`',
  '- Repro: upload a 250 MB fixture with `pnpm repro:upload`. It fails 5 of 5 times.',
  '- Files under 150 MB always pass.',
  '',
  'Suggested fix: pass a per-call timeout of 120 s to `uploadArtifact` only.',
].join('\n');
const REVIEW_NOTE =
  'Heads up: `uploadArtifact` is also called from the nightly backfill. A global timeout change would slow its failure detection.';

function boardTag(args: string[], ctx: ScenarioContext): string | undefined {
  const tag = /^([A-Za-z0-9_-]{1,48})(?=[\s:]|$)/.exec(args[0] ?? '')?.[1];
  if (!tag) ctx.emit.json(400, { error: 'expected board:<tag> or board-child:<tag>' });
  return tag;
}

function answered(ctx: ScenarioContext, callId: string): boolean {
  const body = ctx.body;
  const history =
    typeof body === 'object' && body !== null && 'messages' in body && Array.isArray(body.messages)
      ? body.messages
      : [];
  return history.some(
    (message: unknown) =>
      typeof message === 'object' &&
      message !== null &&
      'tool_call_id' in message &&
      message.tool_call_id === callId
  );
}

function reply(ctx: ScenarioContext, next: ToolCall[] | string) {
  const missing =
    typeof next === 'string'
      ? undefined
      : next.find(call => !ctx.tools.some(tool => tool.name === call.name));
  if (missing) {
    ctx.emit.json(422, { error: `agent board fixture requires the native ${missing.name} tool` });
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
    typeof next === 'string'
      ? { role: 'assistant', content: next }
      : {
          role: 'assistant',
          tool_calls: next.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        }
  );
  chunk({}, typeof next === 'string' ? 'stop' : 'tool_calls');
  ctx.emit.done();
  ctx.emit.end();
}

/** Primary agent: delegates to two children, then posts a note to every board participant. */
export const agentBoardScenario: ScenarioHandler = (args, ctx) => {
  const tag = boardTag(args, ctx);
  if (!tag) return;
  const agents = [
    { id: `board_${tag}_agent`, description: 'Investigate upload timeout', role: 'result' },
    { id: `board_${tag}_review`, description: 'Review upload callers', role: 'review' },
  ];
  const all = `board_${tag}_all`;
  if (!agents.every(agent => answered(ctx, agent.id)))
    return reply(
      ctx,
      agents.map(agent => ({
        name: 'subagent',
        id: agent.id,
        input: {
          agent: 'general',
          description: agent.description,
          prompt: `__fake__:board-child:${tag}:${agent.role}`,
          background: false,
        },
      }))
    );
  if (!answered(ctx, all))
    return reply(ctx, [
      {
        name: 'board_post',
        id: all,
        input: {
          to: 'ALL',
          type: 'INFO',
          body: 'Thanks. I will apply the **120 s** timeout to the release upload only and rerun the release checks.',
        },
      },
    ]);
  reply(ctx, 'Board check complete.');
};

/** Child agent: reports a result, or a review note, to the primary agent on the board. */
export const agentBoardChildScenario: ScenarioHandler = (args, ctx) => {
  const tag = boardTag(args, ctx);
  if (!tag) return;
  const review = /^[^\s:]+:review(?=\s|$)/.test(args[0] ?? '');
  const post = `board_${tag}_${review ? 'review' : 'result'}_post`;
  if (!answered(ctx, post))
    return reply(ctx, [
      {
        name: 'board_post',
        id: post,
        input: review
          ? { to: 'main', type: 'INFO', body: REVIEW_NOTE }
          : { to: 'main', type: 'RESULT', body: CHILD_RESULT },
      },
    ]);
  reply(ctx, 'Posted the result to the board.');
};
