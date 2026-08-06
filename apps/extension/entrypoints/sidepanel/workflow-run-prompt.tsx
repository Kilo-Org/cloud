import type { JSX } from 'react';
import { useState } from 'react';
import type { AgentWorkflow } from '@/src/shared/agent-workflows';

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

const primaryButtonClass =
  'type-label h-8 rounded-md bg-brand-primary px-3 text-brand-primary-foreground transition hover:bg-brand-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle';

/**
 * Modal form collecting values for a workflow's declared params before a
 * manual run. Required params must be filled; optional ones are omitted
 * from the input when left blank.
 */
export const WorkflowRunPrompt = ({
  onCancel,
  onRun,
  workflow,
}: {
  onCancel: () => void;
  onRun: (input: Record<string, string>) => void;
  workflow: AgentWorkflow;
}): JSX.Element => {
  const [values, setValues] = useState<Record<string, string>>({});
  const params = workflow.params ?? [];
  const missingRequired = params.some(
    param => param.required === true && (values[param.name] ?? '').trim() === ''
  );

  const submit = (): void => {
    const input = Object.fromEntries(
      params.flatMap(param => {
        const raw = (values[param.name] ?? '').trim();
        return raw === '' ? [] : [[param.name, raw]];
      })
    );
    onRun(input);
  };

  return (
    <div
      aria-label={`Run workflow "${workflow.name}"`}
      aria-modal="true"
      className="fixed inset-0 z-[30] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
    >
      <div className="flex max-h-full w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface-raised p-3 shadow-lg shadow-black/50">
        <p className="type-body font-semibold text-foreground">Run “{workflow.name}”</p>
        {params.map(param => (
          <label className="flex flex-col gap-1" key={param.name}>
            <span className="type-label text-foreground-muted">
              <span className="font-mono text-foreground">{param.name}</span>
              {param.required === true ? '' : ' (optional)'} — {param.description}
            </span>
            <input
              className="type-body h-8 rounded-md border border-border bg-surface-background px-2 text-foreground placeholder:text-foreground-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
              onChange={event => {
                const { value } = event.target;
                setValues(current => ({ ...current, [param.name]: value }));
              }}
              placeholder={param.example ?? ''}
              value={values[param.name] ?? ''}
            />
          </label>
        ))}
        <div className="flex justify-end gap-2">
          <button className={secondaryButtonClass} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className={primaryButtonClass}
            disabled={missingRequired}
            onClick={submit}
            type="button"
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
};
