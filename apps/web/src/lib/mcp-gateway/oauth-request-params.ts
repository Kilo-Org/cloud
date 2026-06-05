export function hasDuplicateSingletonParams(
  params: URLSearchParams | FormData,
  keys: readonly string[]
): boolean {
  return keys.some(key => params.getAll(key).length > 1);
}

export function stringFormParams(
  form: FormData,
  singletonKeys: readonly string[],
  ignoredKeys: readonly string[] = []
): Record<string, string> | null {
  const singletonKeySet = new Set(singletonKeys);
  const ignoredKeySet = new Set(ignoredKeys);
  const params: Record<string, string> = {};

  for (const [key, value] of form.entries()) {
    if (ignoredKeySet.has(key)) continue;
    if (singletonKeySet.has(key) && typeof value !== 'string') return null;
    if (typeof value !== 'string') continue;
    params[key] = value;
  }

  return params;
}
