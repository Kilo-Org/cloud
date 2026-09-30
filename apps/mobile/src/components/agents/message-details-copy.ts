import { performCopy } from './use-message-copy';

/**
 * Details-sheet Copy path: immediate shared `performCopy`, no ActionSheet.
 * Kept free of RN UI so unit tests can pin the wiring.
 */
export function handleMessageDetailsCopy(copyableText: string | null | undefined): void {
  if (!copyableText) {
    return;
  }
  void performCopy(copyableText);
}
