import { type TFunction } from 'i18next';

import { type SurfaceFeedback } from '@/lib/surface-feedback';

/** A settings save that failed, with the copy the surface shows for it. */
export type SettingsSaveFailure = Readonly<{ kind: 'save-failed'; message: string }>;

/**
 * The one line under an organization settings form: the first thing blocking a
 * save, then the save's own phase. A failure outranks the draft's own state
 * because the person's last action is what did not land. A completed save is
 * only reported while the draft is still what was saved: an edit after it, or a
 * blocking issue it introduced (`clearWhere` retires a failure, never a
 * success), replaces "Saved" with what the form needs next.
 */
export function settingsSaveStatus({
  t,
  feedback,
  draftIsDirty,
  blockingIssue,
}: Readonly<{
  t: TFunction;
  feedback: SurfaceFeedback<SettingsSaveFailure>;
  draftIsDirty: boolean;
  blockingIssue: string | null;
}>): string | null {
  switch (feedback.status) {
    case 'pending': {
      return t('organizationGuardrails.statusSaving');
    }
    case 'succeeded': {
      if (blockingIssue !== null) {
        return blockingIssue;
      }
      return draftIsDirty
        ? t('securityAgent.settingsSave.unsavedTitle')
        : t('organizationGuardrails.statusSaved');
    }
    case 'failed': {
      return feedback.failure.message;
    }
    case 'idle': {
      if (blockingIssue !== null) {
        return blockingIssue;
      }
      return draftIsDirty ? t('securityAgent.settingsSave.unsavedTitle') : null;
    }
    default: {
      return null;
    }
  }
}
