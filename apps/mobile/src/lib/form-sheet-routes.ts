/**
 * Every route the app presents with `useFormSheetScreenOptions()`, as the
 * trailing segments of its route path (`[id]` and `[scope]` are the dynamic
 * patterns `useSegments` reports). The tab layer consults this so a press on
 * the tab that owns a sheet keeps the sheet and the stack under it instead of
 * resetting the tab to its root over the sheet's typed state.
 *
 * Lives apart from the `react-native`-importing `form-sheet.ts` so the pure
 * node test project can read it. `form-sheet-routes.test.ts` (in
 * `tab-press.test.ts`) reads every layout that passes the options hook to a
 * screen and fails when a declared sheet route is missing here.
 */
export const FORM_SHEET_ROUTE_SUFFIXES: readonly (readonly string[])[] = [
  ['agent-chat', 'model-picker'],
  ['agent-chat', 'repo-picker'],
  ['agent-chat', 'branch-picker'],
  ['agent-chat', 'mode-picker'],
  ['agent-chat', 'instance-picker'],
  ['agent-chat', 'folder-picker'],
  ['agent-chat', 'profile-picker'],
  ['todos', 'list-settings'],
  ['share-gate'],
  ['language-picker'],
  ['transcription-model-picker'],
  ['voice-language-picker'],
  ['organization', 'invite-member'],
  ['organization', 'member-limit'],
  ['organization', 'low-balance-alert'],
  ['chat', 'instance-picker'],
  ['dismiss', '[id]'],
  ['filter'],
  ['comment-composer'],
  ['conversation-comment'],
  ['comment-edit'],
  ['review-submit'],
  ['merge'],
  ['file-navigator'],
];

/** Is the route these segments point at presented as a form sheet? */
export function isFormSheetRoute(segments: readonly string[]): boolean {
  return FORM_SHEET_ROUTE_SUFFIXES.some(suffix => {
    const tail = segments.slice(-suffix.length);
    return (
      tail.length === suffix.length && tail.every((segment, index) => segment === suffix[index])
    );
  });
}
