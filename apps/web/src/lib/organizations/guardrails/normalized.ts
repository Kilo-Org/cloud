export type Normalized<T> = { ok: true; value: T } | { ok: false; reason: string };
