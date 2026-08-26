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
 *
 * `h-full min-h-0` makes this column match the drawer body's own height
 * (the scrollable `flex-1` container `DrawerStack.tsx` renders it into)
 * rather than sizing to its content — so a step's scrollable list, given
 * `flex-1 min-h-0` itself, actually fills the remaining space instead of
 * capping at an arbitrary height and leaving the rest of the drawer blank.
 */
export function WizardChrome({ stepTitle, children }: { stepTitle: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {stepTitle}
      </p>
      {children}
    </div>
  );
}
