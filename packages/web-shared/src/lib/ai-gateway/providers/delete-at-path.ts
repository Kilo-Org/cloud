import { REMOVE_FROM_BODY_BLOCKED_SEGMENTS } from '@kilocode/db';

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function deleteSegments(target: unknown, segments: readonly string[]) {
  if (!isContainer(target)) return;
  const [segment, ...rest] = segments;
  if (segment === '*') {
    for (const child of Object.values(target)) deleteSegments(child, rest);
    return;
  }
  if (Array.isArray(target) || !Object.hasOwn(target, segment)) return;
  if (rest.length === 0) {
    delete target[segment];
  } else {
    deleteSegments(target[segment], rest);
  }
}

/**
 * Deletes the field a dotted path names, for example `usage`, `tools.*.function.strict` or
 * `messages.*.content.*.cache_control`. `*` stands for every element of an array or every value
 * of an object; a plain segment never reaches into array elements. Where an intermediate value is
 * missing or is not an object or array, nothing is deleted. Only own properties are visited.
 */
export function deleteAtPath(root: unknown, path: string) {
  const segments = path.split('.');
  if (
    segments.some(
      segment => segment === '' || REMOVE_FROM_BODY_BLOCKED_SEGMENTS.has(segment)
    ) ||
    segments[segments.length - 1] === '*'
  ) {
    return;
  }
  deleteSegments(root, segments);
}
