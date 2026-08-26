import type { ReactNode } from 'react';

/**
 * Shared outer scaffold for every step-based wizard in the member
 * management drawer: the padded flex column and the uppercase step-title
 * caption shown above whichever step is currently active. All three wizards
 * (add-people, remove-people, invite-person) had this identical wrapper
 * duplicated before it was pulled out here — the same "obvious at n+1"
 * abstraction moment as the `MemberManagementDrawerEntry` union in
 * `types.ts`, just one file over.
 *
 * Each wizard keeps its own `STEP_TITLES` record — the step names and
 * count ("Step 2 of 4: ...") are wizard-specific — and passes the current
 * step's title in as `stepTitle`.
 */
export function WizardChrome({ stepTitle, children }: { stepTitle: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {stepTitle}
      </p>
      {children}
    </div>
  );
}
