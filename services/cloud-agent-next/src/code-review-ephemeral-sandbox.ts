export const CODE_REVIEW_EPHEMERAL_SANDBOX_DESTROY_DELAY_MS = 60_000;

export function isCodeReviewEphemeralSandboxId(sandboxId: string | undefined): boolean {
  return sandboxId?.startsWith('crv-') === true;
}
