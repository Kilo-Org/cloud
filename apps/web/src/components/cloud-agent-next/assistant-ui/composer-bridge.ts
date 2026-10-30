export type SubmittedDraft = {
  conversationKey: string;
  revision: number;
  text: string;
  attachmentIds: readonly string[];
};

/** SDK acceptance applies only to the originating draft revision. */
export function ownsSubmittedDraft(
  submission: SubmittedDraft,
  conversationKey: string,
  revision: number
) {
  return submission.conversationKey === conversationKey && submission.revision === revision;
}
export function canRestoreSubmittedDraft(
  submission: SubmittedDraft,
  revision: number,
  text: string
) {
  return submission.revision === revision && text === '';
}

export function canRestoreFailedPrompt(
  submission: SubmittedDraft | undefined,
  conversationKey: string,
  revision: number,
  text: string,
  failedPrompt: string
) {
  if (!submission) return false;
  return (
    submission.conversationKey === conversationKey &&
    submission.text.trim() === failedPrompt.trim() &&
    canRestoreSubmittedDraft(submission, revision, text)
  );
}
