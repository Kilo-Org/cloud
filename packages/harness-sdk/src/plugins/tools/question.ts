import { type Duration, Effect } from 'effect';
import { createAssert } from 'typia';
import { type Tool, ToolFailure, type ToolCall, type JsonSchema } from '../../core/tool.js';

/**
 * The one tool no harness can do without, and the one no harness can write for
 * itself: asking the person a question.
 *
 * Everything about the question is the model's: how many, what each says, what
 * may be picked, whether one answer or several, whether it may be skipped.
 * Everything about the asking is the caller's: a terminal prompt, a dialog, a
 * form on a web page, a message to somebody on call. This holds the middle —
 * the shape of a question, the shape of an answer, and the words the model gets
 * back — so the two never have to agree on anything else.
 *
 * A question outlives a request more often than not. Nobody answers in the
 * moment they are asked, and a model that had to wait would hold a request open
 * on a person making coffee. So the tool is backgrounded like any other: the
 * model is told the question is out, carries on with what does not depend on
 * it, and the session starts a round of its own when the answer arrives.
 */

/** One thing a person may pick. `value` comes back; `label` is what they read. */
interface Choice {
  readonly value: string;
  readonly label: string;
  /** Why somebody would pick this one. Shown under the label where there is room. */
  readonly description?: string;
}

/** One question. No `choices` means the answer is whatever the person types. */
interface Question {
  /** The model's name for this question. The answer carries it back. */
  readonly id: string;
  readonly prompt: string;
  readonly choices?: readonly Choice[];
  /** Several choices at once rather than one. Ignored where there are none. */
  readonly multiple?: boolean;
  /** The person may answer nothing. By default an answer is expected. */
  readonly optional?: boolean;
}

/**
 * What came back for one question.
 *
 * A caller fills in `chosen` for what was picked and `text` for what was typed.
 * Neither, and the question went unanswered, which is a fact the model needs
 * rather than an error: a person who skips a question has told you something.
 */
interface Answer {
  readonly id: string;
  readonly chosen?: readonly string[];
  readonly text?: string;
}

/**
 * How this harness asks. The caller writes one of these and nothing else.
 *
 * It may take as long as it likes and may fail: neither ends the session. A
 * failure reaches the model as a failed result, which is the only party that
 * can decide whether to ask again, ask differently, or carry on without. Fail
 * with a `ToolFailure` to choose the words the model reads; anything else is
 * wrapped and reaches it as whatever it prints as.
 */
type Asker = (questions: readonly Question[]) => Effect.Effect<readonly Answer[], unknown>;

/** What the model sends. Anything else is a failed result and a chance to retry. */
interface Asked {
  readonly questions: readonly Question[];
}

const assertAsked = createAssert<Asked>();

const choiceSchema = {
  type: 'object',
  properties: {
    value: { type: 'string', description: 'What comes back when this one is picked.' },
    label: { type: 'string', description: 'The words the person reads.' },
    description: { type: 'string', description: 'Why somebody would pick this one.' },
  },
  required: ['value', 'label'],
} as const;

const questionSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Your name for this question. The answer comes back under it.',
    },
    prompt: { type: 'string', description: 'The question, as the person will read it.' },
    choices: {
      type: 'array',
      items: choiceSchema,
      description: 'What may be picked. Leave it out to let the person write an answer.',
    },
    multiple: {
      type: 'boolean',
      description: 'Whether several choices may be picked at once. Ignored without choices.',
    },
    optional: { type: 'boolean', description: 'Whether the question may be left unanswered.' },
  },
  required: ['id', 'prompt'],
} as const;

const parameters: JsonSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      items: questionSchema,
      description: 'Every question at once. Asking together is cheaper than asking in turn.',
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

const description =
  'Asks the person one or more questions and returns their answers. Ask ' +
  'everything you need in one call rather than one question at a time. A ' +
  'question with choices is answered by picking from them; a question without ' +
  "is answered in the person's own words. Waiting is the default, because you " +
  'asked to find something out; set wait to false and carry on if there is ' +
  'useful work the answer does not block.';

/** What the model sent, or a failed result saying what was wrong with it. */
const asked = (call: ToolCall): Effect.Effect<Asked, ToolFailure> =>
  Effect.try({
    try: () => assertAsked(JSON.parse(call.arguments)),
    catch: cause => new ToolFailure({ cause }),
  });

/** One answer, in words. What was picked, or what was typed, or nothing. */
const wordsOf = (answer: Answer | undefined): string => {
  if (answer === undefined) {
    return '(not answered)';
  }
  const chosen = answer.chosen ?? [];
  if (chosen.length > 0) {
    return chosen.join(', ');
  }
  return answer.text === undefined || answer.text === '' ? '(not answered)' : answer.text;
};

/**
 * The answers as the model reads them, in the order it asked.
 *
 * It walks the questions rather than the answers, so a caller who answers two
 * of three questions is reported as answering two of three, and an answer for a
 * question nobody asked is dropped rather than shown as one the model wrote.
 */
const wordsFor = (questions: readonly Question[], answers: readonly Answer[]): string =>
  questions
    .map(question => {
      const answer = answers.find(one => one.id === question.id);
      return `${question.prompt} [${question.id}]\n${wordsOf(answer)}`;
    })
    .join('\n\n');

/** What the caller may change about the tool. Everything else is the model's. */
interface QuestionOptions {
  /**
   * How long the model waits before carrying on without the answer. It falls
   * back to the session's own deadline, which is what most callers want: the
   * person is asked either way, and only the waiting is cut short.
   */
  readonly inlineFor?: Duration.DurationInput;
  /**
   * Whether the model waits for an answer, as it is told by default. True,
   * because a model asks in order to find something out. A harness whose
   * people answer slowly, or whose model always has other work, says false.
   */
  readonly wait?: boolean;
  /** The name the model calls it by, for a harness that already has one. */
  readonly name?: string;
}

/**
 * The tool, given a way to ask.
 *
 * **It holds one permit, so the asker is never called again before the last
 * call answers.** That is what lets a caller write one that owns the terminal,
 * or one dialog, without a lock of its own.
 *
 * The permit is here rather than in the session because the session is not what
 * it protects: the asker is, and one asker is one terminal and one person. A
 * session knows nothing about either. So one `questionTool(ask)` is one person
 * asked one thing at a time, however many sessions call it — and two of them
 * over one asker is two permits and two dialogs, which is a reason to build one.
 */
const questionTool = (ask: Asker, options?: QuestionOptions): Tool => {
  const permit = Effect.unsafeMakeSemaphore(1);
  return {
    definition: { name: options?.name ?? 'question', description, parameters },
    /* The model asked because it cannot go on without the answer, so waiting is
       what it wants. It is still only the default: a model with work the answer
       does not block says so on the call, and the deadline still moves it on. */
    wait: options?.wait ?? true,
    ...(options?.inlineFor === undefined ? {} : { inlineFor: options.inlineFor }),
    run: (call: ToolCall) =>
      permit.withPermits(1)(
        Effect.flatMap(asked(call), ({ questions }) =>
          ask(questions).pipe(
            Effect.mapError(cause =>
              cause instanceof ToolFailure ? cause : new ToolFailure({ cause })
            ),
            Effect.map(answers => wordsFor(questions, answers))
          )
        )
      ),
  };
};

export type { Answer, Asker, Choice, Question, QuestionOptions };
export { questionTool };
