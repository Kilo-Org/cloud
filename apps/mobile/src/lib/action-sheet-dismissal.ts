/**
 * Resolve on the next frame, after React has removed the action sheet's modal.
 *
 * The themed sheet (`useModal`) runs its option callback before its modal
 * closes. On iOS a native picker presented from that callback opens on the
 * closing modal, and UIKit dismisses the picker with it without a result: the
 * picker promise never settles, and expo-document-picker rejects every later
 * call with "Different document picking in progress" until the app restarts.
 * Await this before a sheet callback presents native UI.
 */
export async function waitForActionSheetDismissal(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  requestAnimationFrame(() => {
    resolve(undefined);
  });
  await promise;
}
