export function hasDuplicateQueryParameters(searchParams: URLSearchParams): boolean {
  const seenParams = new Set<string>();
  for (const key of searchParams.keys()) {
    if (seenParams.has(key)) return true;
    seenParams.add(key);
  }
  return false;
}
