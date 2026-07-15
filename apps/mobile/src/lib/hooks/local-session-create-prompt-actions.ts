/**
 * Pure wrappers that bind recovery-CTAs to the controller without ever
 * touching the prompt ref. The prompt is owned by an uncontrolled
 * `TextInput` whose content lives in a ref; neither action helper is allowed
 * to write to that ref or call any setter that could overwrite it.
 *
 * The wrappers exist as named, testable seams so the screen does not
 * re-implement the "preserve the prompt" contract inline, where it would
 * have to be reasoned about by source inspection rather than a test.
 */

import { type LocalSessionConfigController } from './use-local-session-config-controller';

type PromptRef = { current: string };

export function preservePromptOnClearFence(input: {
  controller: LocalSessionConfigController;
  promptRef: PromptRef;
}): void {
  input.controller.onClearFence();
}

export function preservePromptOnRefreshCatalog(input: {
  refetchCatalog: () => void;
  onResetOverrides: () => void;
  promptRef: PromptRef;
}): void {
  input.refetchCatalog();
  input.onResetOverrides();
}
