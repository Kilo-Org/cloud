type RemoteCliExitConfirmation = () => Promise<boolean>;

export async function confirmRemoteCliExit(
  confirm: RemoteCliExitConfirmation,
  exit: () => Promise<void>
): Promise<'accepted' | 'cancelled'> {
  if (!(await confirm())) {
    return 'cancelled';
  }
  await exit();
  return 'accepted';
}
