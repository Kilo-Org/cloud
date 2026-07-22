type RemoteSessionExitConfirmation = () => Promise<boolean>;

export async function confirmRemoteSessionExit(
  confirm: RemoteSessionExitConfirmation,
  exit: () => Promise<void>
): Promise<'accepted' | 'cancelled'> {
  if (!(await confirm())) {
    return 'cancelled';
  }
  await exit();
  return 'accepted';
}
