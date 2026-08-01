import { useCallback, useState } from 'react';
import type { JSX } from 'react';
import type {
  StandaloneQuestion,
  StandalonePermission,
  QuestionInfo,
} from '@kilocode/cloud-agent-sdk';

type QuestionOption = QuestionInfo['options'][number];

// ---- Permission card ----

const PermissionCard = ({
  permission,
  onRespond,
}: {
  permission: StandalonePermission;
  onRespond: (requestId: string, response: 'once' | 'always' | 'reject') => Promise<void>;
}): JSX.Element => {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = useCallback(
    async (response: 'once' | 'always' | 'reject') => {
      setError(null);
      setResponding(true);
      try {
        await onRespond(permission.requestId, response);
        setResponding(false);
      } catch {
        setError('Failed to respond. Please try again.');
        setResponding(false);
      }
    },
    [permission.requestId, onRespond]
  );

  return (
    <div className="rounded-lg border border-border bg-surface-raised px-4 py-3">
      <p className="type-label mb-2 font-medium text-foreground">Permission required</p>
      <p className="type-body mb-1 text-foreground">{permission.permission}</p>
      {permission.patterns.length > 0 ? (
        <div className="mb-2 space-y-0.5">
          {permission.patterns.map((pattern, _index) => (
            <code
              className="block rounded bg-surface-selected px-1.5 py-0.5 font-mono text-xs text-foreground-muted"
              key={`${permission.requestId}-${pattern}`}
            >
              {pattern}
            </code>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          className="h-8 rounded-md border border-border bg-surface-overlay px-3 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:opacity-50"
          disabled={responding}
          onClick={() => {
            void respond('once');
          }}
          type="button"
        >
          Yes, once
        </button>
        <button
          className="h-8 rounded-md border border-border bg-surface-overlay px-3 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:opacity-50"
          disabled={responding}
          onClick={() => {
            void respond('always');
          }}
          type="button"
        >
          Yes, always
        </button>
        <button
          className="h-8 rounded-md border border-border bg-surface-overlay px-3 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:opacity-50"
          disabled={responding}
          onClick={() => {
            void respond('reject');
          }}
          type="button"
        >
          No
        </button>
      </div>
      {error === null ? null : <p className="mt-2 type-label text-status-red-400">{error}</p>}
    </div>
  );
};

// ---- Question card ----

const QuestionOptionButton = ({
  option,
  onPick,
  disabled,
}: {
  option: QuestionOption;
  onPick: (label: string) => void;
  disabled: boolean;
}): JSX.Element => (
  <button
    className="flex flex-col items-start rounded-md border border-border bg-surface-overlay px-3 py-2 text-left type-body transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:opacity-50"
    disabled={disabled}
    onClick={() => {
      onPick(option.label);
    }}
    type="button"
  >
    <span className="text-foreground">{option.label}</span>
    {option.description ? (
      <span className="mt-0.5 type-label text-foreground-muted">{option.description}</span>
    ) : null}
  </button>
);

/**
 * Picks one option per question. `multiple` → still single-select per question
 * (decision 14: one picked option per question, no free-text input).
 */
const QuestionBlock = ({
  index,
  question,
  onPick,
  selected,
  disabled,
}: {
  index: number;
  question: QuestionInfo;
  onPick: (questionIndex: number, label: string) => void;
  selected: string | undefined;
  disabled: boolean;
}): JSX.Element => (
  <div className="space-y-1.5">
    <p className="type-label font-medium text-foreground">{question.header}</p>
    {question.question ? (
      <p className="type-body text-xs text-foreground-muted">{question.question}</p>
    ) : null}
    <div className="space-y-1">
      {question.options.map(option => (
        <QuestionOptionButton
          disabled={disabled}
          key={option.label}
          onPick={label => {
            onPick(index, label);
          }}
          option={option}
        />
      ))}
    </div>
    {selected === undefined ? null : (
      <p className="type-label text-foreground-muted">Selected: {selected}</p>
    )}
  </div>
);

const QuestionCard = ({
  question,
  onAnswer,
  onReject,
}: {
  question: StandaloneQuestion;
  onAnswer: (requestId: string, answers: string[][]) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
}): JSX.Element => {
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allAnswered =
    question.questions.length > 0 &&
    question.questions.every((_unused, index) => selected[index] !== undefined);

  const pick = useCallback((questionIndex: number, label: string) => {
    setSelected(prev => ({ ...prev, [questionIndex]: label }));
  }, []);

  const submit = useCallback(async () => {
    if (!allAnswered) {
      return;
    }
    setError(null);
    setSending(true);
    try {
      const answers = question.questions.map((_unused, index) => [selected[index]!]);
      await onAnswer(question.requestId, answers);
      setSending(false);
    } catch {
      setError('Failed to submit answer. Please try again.');
      setSending(false);
    }
  }, [allAnswered, question, selected, onAnswer]);

  const dismiss = useCallback(async () => {
    setError(null);
    setSending(true);
    try {
      await onReject(question.requestId);
      setSending(false);
    } catch {
      setError('Failed to dismiss. Please try again.');
      setSending(false);
    }
  }, [question.requestId, onReject]);

  return (
    <div className="rounded-lg border border-border bg-surface-raised px-4 py-3">
      <div className="space-y-3">
        {question.questions.map((questionInfo, index) => (
          <QuestionBlock
            disabled={sending}
            index={index}
            // eslint-disable-next-line react/no-array-index-key -- requestId plus index make a stable key even with duplicate headers
            key={`${question.requestId}-${index}`}
            onPick={pick}
            question={questionInfo}
            selected={selected[index]}
          />
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className="h-8 rounded-md border border-transparent bg-brand-primary px-3 type-label text-brand-primary-foreground transition hover:bg-brand-primary-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle"
          disabled={!allAnswered || sending}
          onClick={() => {
            void submit();
          }}
          type="button"
        >
          Answer
        </button>
        <button
          className="h-8 rounded-md border border-border bg-surface-overlay px-3 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:opacity-50"
          disabled={sending}
          onClick={() => {
            void dismiss();
          }}
          type="button"
        >
          Dismiss
        </button>
      </div>
      {error === null ? null : <p className="mt-2 type-label text-status-red-400">{error}</p>}
    </div>
  );
};

// ---- Exported container ----

export const AgentsBlockingCards = ({
  activeQuestion,
  activePermission,
  onAnswerQuestion,
  onRejectQuestion,
  onRespondToPermission,
}: {
  activeQuestion: StandaloneQuestion | null;
  activePermission: StandalonePermission | null;
  onAnswerQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  onRejectQuestion: (requestId: string) => Promise<void>;
  onRespondToPermission: (
    requestId: string,
    response: 'once' | 'always' | 'reject'
  ) => Promise<void>;
}): JSX.Element | null => {
  if (activeQuestion) {
    return (
      <div className="shrink-0 border-t border-status-yellow-500/30 bg-status-yellow-500/10 px-4 py-3">
        <QuestionCard
          key={activeQuestion.requestId}
          onAnswer={onAnswerQuestion}
          onReject={onRejectQuestion}
          question={activeQuestion}
        />
      </div>
    );
  }

  if (activePermission) {
    return (
      <div className="shrink-0 border-t border-status-yellow-500/30 bg-status-yellow-500/10 px-4 py-3">
        <PermissionCard
          key={activePermission.requestId}
          onRespond={onRespondToPermission}
          permission={activePermission}
        />
      </div>
    );
  }

  return null;
};
