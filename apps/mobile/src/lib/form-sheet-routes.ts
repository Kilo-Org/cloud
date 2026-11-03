/**
 * Every route the app presents with `useFormSheetScreenOptions()`, as the
 * trailing segments of its route path (`[id]` and `[scope]` are the dynamic
 * patterns `useSegments` reports). The tab layer consults this so a press on
 * the tab that owns a sheet keeps the sheet and the stack under it instead of
 * resetting the tab to its root over the sheet's typed state.
 *
 * Lives apart from the `react-native`-importing `form-sheet.ts` so the pure
 * node test project can read it. The `form sheet route declarations` suite in
 * `tab-press.test.ts` reads every layout that passes the options hook to a
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
  return FORM_SHEET_ROUTE_SUFFIXES.some(suffix => matchesSuffix(segments, suffix));
}

/**
 * Is the route a persisted href names presented as a form sheet?
 *
 * A stored href carries the concrete value of every dynamic segment
 * (`dismiss/<uuid>`) and the layout groups in the path, while the suffix list
 * names the pattern, so a pattern segment matches any value.
 */
export function isFormSheetRouteHref(href: string): boolean {
  const queryStart = href.indexOf('?');
  const path = queryStart === -1 ? href : href.slice(0, queryStart);
  return FORM_SHEET_ROUTE_SUFFIXES.some(suffix => matchesSuffix(path.split('/'), suffix));
}

function matchesSuffix(segments: readonly string[], suffix: readonly string[]): boolean {
  const tail = segments.slice(-suffix.length);
  return (
    tail.length === suffix.length &&
    tail.every(
      (segment, index) => suffix[index]?.startsWith('[') === true || segment === suffix[index]
    )
  );
}
