import { type SaveProfileSubmission } from '@/components/agents/save-profile-sheet';
import { type VariableEdit } from '@/components/profiles/profile-variables-model';

/** The vars, commands and default flag one save carries, beside its name. */
export type SaveProfileDraft = Readonly<{
  vars: readonly VariableEdit[];
  commands: readonly string[];
  submission: SaveProfileSubmission;
  /** The trimmed name, the form the server stores and compares. */
  name: string;
}>;

/**
 * The one `agentProfiles.create` input the `Save as profile` sheet sends. The
 * profile, its variables, its setup commands and the default flag travel in this
 * single call, so the server commits them together and a refused attempt cannot
 * leave a profile holding only part of the configuration.
 *
 * Optional collections are omitted instead of sent empty: the router reads an
 * absent field as "nothing to store", and an empty array would be a payload the
 * create does not need. The name is the caller's trimmed one, so its own reading
 * and this request cannot disagree.
 */
export function profileSaveCreateInput(draft: SaveProfileDraft) {
  const { vars, commands, submission, name } = draft;
  return {
    name,
    description: submission.description === '' ? undefined : submission.description,
    ...(vars.length > 0
      ? {
          vars: vars.map(variable => ({
            key: variable.key,
            value: variable.value,
            isSecret: variable.isSecret,
          })),
        }
      : {}),
    ...(commands.length > 0 ? { commands: [...commands] } : {}),
    ...(submission.setAsDefault ? { setAsDefault: true } : {}),
  };
}
