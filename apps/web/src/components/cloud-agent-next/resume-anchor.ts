import { anchorPosition } from '@kilocode/app-shared/universal-links';

/**
 * Where a resumed transcript should land, resolved against the rendered
 * conversation groups. `groupIndex` is the group the anchor belongs to and
 * `selectorIds` are the ids to look up in the DOM, nearest first: the anchor
 * group's first message id — the id that group's rendered content carries in
 * `data-message-id`, so an anchor sitting mid-group lands on the group's start
 * — followed by the first id of every group after it.
 *
 * The later ids are not decoration: a group can render no element at all (an
 * assistant turn whose parts are all invisible), and such a group must not read
 * as "the anchor has not loaded yet". The caller probes `selectorIds` in order
 * and uses the nearest group that did render.
 */
export type ResumeAnchor = {
  /** Index into the rendered conversation groups. */
  readonly groupIndex: number;
  /** `data-message-id` values to probe for the scroll target, nearest first. */
  readonly selectorIds: readonly string[];
};

/**
 * Resolve a stored anchor against the message ids the transcript has grouped
 * for rendering. Null when the anchor is absent from those ids — the caller
 * then loads an older page, and gives up if it never appears.
 *
 * `groups` holds each rendered group's message ids in server order; the flat
 * order of `groups` is the same order `anchorPosition` expects.
 */
export function resumeAnchor(
  groups: readonly (readonly string[])[],
  anchorMessageId: string | null | undefined
): ResumeAnchor | null {
  const position = anchorPosition(groups.flat(), anchorMessageId ?? '');
  if (position === null) {
    return null;
  }

  let offset = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (group.length === 0) {
      continue;
    }
    if (position < offset + group.length) {
      return {
        groupIndex,
        selectorIds: groups
          .slice(groupIndex)
          .map(candidate => candidate[0])
          .filter((id): id is string => Boolean(id)),
      };
    }
    offset += group.length;
  }

  return null;
}
