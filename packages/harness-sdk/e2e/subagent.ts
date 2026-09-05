/**
 * Proves a subagent against the provider, and the caller sending one away.
 *
 * Two things only a real model can settle. Whether a model reads the subagent
 * tool as something to hand a whole task to — rather than a thing to ask a
 * fragment of, or to narrate around — and whether the answer that comes back is
 * usable as an answer. A fake agrees with whatever the test writes.
 *
 * Three claims:
 *
 * - **A task goes down and one answer comes up.** The subagent is told a word
 *   the parent never sees, and the parent's answer carries it, so the answer
 *   came through the tool rather than out of the parent's own head.
 * - **The subagent is a session of its own.** Its identifier is not the
 *   parent's, its counts are its own, and its steps are not in the parent's
 *   transcript.
 * - **A running subagent can be sent away by the caller.** The deadline here is
 *   five minutes, so nothing but `session.background` moves the model on. It
 *   answers without the subagent, and is told the result in a round of its own
 *   when it lands.
 */
import { Duration, Effect, Layer, Schedule, Stream } from 'effect';
import { said } from '../src/core/model.js';
import type { Continued } from '../src/core/queue.js';
import { openSession } from '../src/core/run.js';
import { ToolRegistry } from '../src/core/tool.js';
import { type SubagentReport, subagentTool } from '../src/plugins/tools/subagent.js';
import { kilo, models } from './setup.js';
import { fail, passed, under, wrongIf } from './report.js';

const system =
  'You are a test harness with a subagent tool. When the person asks for ' +
  'something the subagent can find out, hand it the whole task in one call ' +
  'and answer with what it tells you. Keep your answer to one short sentence.';

/**
 * What the subagent is told, and the parent never is. An answer carrying this
 * word came up through the tool.
 */
const secret = 'nightjar';

const subSystem =
  'You are a lookup service. The codename for this quarter is ' +
  `"${secret}". Answer in one short sentence, and always give the codename ` +
  'when asked for it.';

const reports: SubagentReport[] = [];

const layers = kilo();

/**
 * `wait` is what this harness tells the model by default, and both runs below
 * ask for the waiting one: a task the model is then held on is what makes the
 * hand-off and the sending away visible where the question was asked. The
 * package's own default is the opposite, and `subagent.test.ts` covers it.
 */
const subagent = (model: string, inlineFor: Duration.DurationInput) =>
  subagentTool(
    {
      system: subSystem,
      model,
      maxTokens: 128,
      inlineFor,
      wait: true,
      onFinished: report => Effect.sync(() => void reports.push(report)),
    },
    layers
  );

const withSubagent = (model: string, inlineFor: Duration.DurationInput) =>
  Layer.merge(layers, Layer.succeed(ToolRegistry, { tools: [subagent(model, inlineFor)] }));

/** A task handed down, and one answer handed up. */
const runHandOff = async (model: string): Promise<void> => {
  const program = Effect.gen(function* () {
    const session = yield* openSession({
      system,
      model,
      maxTokens: 256,
      tools: ['subagent'],
    });
    const answer = yield* said(session.ask('Ask the subagent for this quarter’s codename.'));
    return { id: session.id, answer, history: yield* session.history, usage: yield* session.usage };
  });

  const got = await Effect.runPromise(
    Effect.either(Effect.scoped(Effect.provide(program, withSubagent(model, '5 minutes'))))
  );

  if (got._tag === 'Left') {
    fail(`the hand-off failed: ${JSON.stringify(got.left)}`);
    return;
  }

  const { id, answer, history, usage } = got.right;
  const report = reports[0];
  const written = history.map(turn => turn.parts.map(part => part.body).join('')).join(' | ');
  console.log(`\nthe parent answered: ${JSON.stringify(answer.trim())}`);
  console.log(`the subagent said:   ${JSON.stringify(report?.said.trim() ?? '')}`);
  console.log(
    `parent spent ${String(usage.inputTokens + usage.outputTokens)} tokens, ` +
      `subagent ${String((report?.usage.inputTokens ?? 0) + (report?.usage.outputTokens ?? 0))}`
  );

  wrongIf(!answer.toLowerCase().includes(secret), 'the parent never got what the subagent knew');
  wrongIf(report === undefined, 'the subagent never reported what it did');
  wrongIf(report?.sessionId === id, 'the subagent ran in the parent’s session, not one of its own');
  wrongIf(
    (report?.usage.inputTokens ?? 0) === 0,
    'the subagent reported no tokens, so its counts are not its own'
  );
  wrongIf(
    !written.toLowerCase().includes(secret),
    'the parent’s transcript does not hold the answer it was given'
  );
};

/**
 * The same tool, sent away by the caller while it runs.
 *
 * Nothing here is the clock: the deadline is five minutes. What moves the model
 * on is a caller deciding it has waited long enough, which is the same call an
 * agent watching its own work would make.
 */
const runSentAway = async (model: string): Promise<void> => {
  const rounds: string[] = [];
  const program = Effect.gen(function* () {
    const session = yield* openSession({
      system,
      model,
      maxTokens: 256,
      tools: ['subagent'],
    });
    const watching = yield* Effect.fork(
      Effect.timeout(
        Stream.runForEach(
          Stream.takeUntil(session.continued, one => 'failed' in one || one.event.kind === 'done'),
          (one: Continued) =>
            Effect.sync(() => {
              if (!('failed' in one) && one.event.kind === 'delta') {
                rounds.push(one.event.text);
              }
            })
        ),
        '120 seconds'
      )
    );
    /* Watch the running calls, and send the subagent away the moment the model
       is waiting on one. */
    const sending = yield* Effect.fork(
      Effect.retry(
        Effect.flatMap(session.running, waiting => {
          const one = waiting[0];
          return one === undefined
            ? Effect.fail('not yet' as const)
            : Effect.map(session.background(one.id), sent => ({ sent, on: one }));
        }),
        Schedule.spaced('50 millis').pipe(Schedule.upTo('60 seconds'))
      )
    );
    const answer = yield* said(session.ask('Ask the subagent for this quarter’s codename.'));
    const sent = yield* sending.await;
    yield* watching.await;
    return { answer, sent };
  });

  const got = await Effect.runPromise(
    Effect.either(Effect.scoped(Effect.provide(program, withSubagent(model, '5 minutes'))))
  );

  if (got._tag === 'Left') {
    fail(`the sent-away run failed: ${JSON.stringify(got.left)}`);
    return;
  }

  const later = rounds.join('');
  const sent = got.right.sent._tag === 'Success' ? got.right.sent.value : undefined;
  console.log(`\nsent away: ${JSON.stringify(sent?.on.name ?? 'nothing')}`);
  console.log(`answered without it: ${JSON.stringify(got.right.answer.trim())}`);
  console.log(`told later:          ${JSON.stringify(later.trim())}`);

  wrongIf(sent?.sent !== true, 'the caller could not send the running subagent away');
  wrongIf(sent?.on.name !== 'subagent', `the model was waiting on ${String(sent?.on.name)}`);
  wrongIf(
    got.right.answer.toLowerCase().includes(secret),
    'the model was given the answer inline, so nothing was sent away'
  );
  wrongIf(!later.toLowerCase().includes(secret), 'the session never told the model what came back');
};

for (const model of models) {
  under(model);

  console.log('model', model);
  reports.length = 0;
  await runHandOff(model);
  await runSentAway(model);
}

passed(
  'a task went down to a session of its own and one answer came up, and ' +
    'a running subagent was sent away by the caller.'
);
