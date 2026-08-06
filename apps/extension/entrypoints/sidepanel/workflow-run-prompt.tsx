import type { JSX } from 'react';
import { useState } from 'react';
import type { AgentWorkflowParam } from '@/src/shared/agent-workflows';

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

const primaryButtonClass =
  'type-label h-8 rounded-md bg-brand-primary px-3 text-brand-primary-foreground transition hover:bg-brand-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle';

/**
 * Collects values for a workflow's declared params before a manual run.
 * Required params gate the Run button; blank optional params are omitted
 * from the input so the script sees undefined rather than an empty string.
 */
export const WorkflowRunPrompt = ({
  name,
  onCancel,
  onRun,
  params,
}: {
  name: string;
  onCancel: () => void;
  onRun: (input: Record<string, string>) => void;
  params: readonly AgentWorkflowParam[];
}): JSX.Element => {
  const [values, setValues] = useState<Record<string, string>>({});
  const missingRequired = params.some(
    param => param.required === true && (values[param.name] ?? '').trim() === ''
  );

  const submit = (): void => {
    onRun(
      Object.fromEntries(
        params.flatMap(param => {
          const raw = (values[param.name] ?? '').trim();
          return raw === '' ? [] : [[param.name, raw]];
        })
      )
    );
  };

  return (
    <div
      aria-label={`Run workflow "${name}"`}
      aria-modal="true"
      className="fixed inset-0 z-[30] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
    >
      <div className="flex max-h-full w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface-raised p-3 shadow-lg shadow-black/50">
        <p className="type-body font-semibold text-foreground">Run “{name}”</p>
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
