export function resolveSessionComposerDisabled(input: {
  isReadOnly: boolean;
  canSend: boolean;
  shouldShowLoading: boolean;
  hasBlockingInteraction: boolean;
  requiresModel: boolean;
  hasModel: boolean;
}): boolean {
  return (
    input.isReadOnly ||
    !input.canSend ||
    input.shouldShowLoading ||
    input.hasBlockingInteraction ||
    (input.requiresModel && !input.hasModel)
  );
}
