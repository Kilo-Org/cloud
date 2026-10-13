/**
 * Pauses of a native execution's no-progress clock: waiting on the user (`waitingSince`) and
 * its Kilo runtime held under memory pressure (`heldSince`). The two can overlap; paused time
 * counts their union once.
 */
export type ExecutionPauses = {
  pausedMs: number;
  waitingSince?: number;
  heldSince?: number;
};

type PauseSource = 'waitingSince' | 'heldSince';

const OTHER_PAUSE: Record<PauseSource, PauseSource> = {
  waitingSince: 'heldSince',
  heldSince: 'waitingSince',
};

/** Time the execution spent paused since its last progress. */
export function pausedMs(clock: ExecutionPauses, now: number): number {
  const open = [clock.waitingSince, clock.heldSince].filter(at => at !== undefined);
  return open.length === 0 ? clock.pausedMs : clock.pausedMs + Math.max(0, now - Math.min(...open));
}

export function beginPause(clock: ExecutionPauses, source: PauseSource, now: number): void {
  clock[source] ??= now;
}

/** Credits only the part of this pause that the other, still open one does not cover. */
export function endPause(clock: ExecutionPauses, source: PauseSource, now: number): void {
  const since = clock[source];
  if (since === undefined) return;
  const other = clock[OTHER_PAUSE[source]];
  clock.pausedMs += Math.max(0, (other === undefined ? now : Math.min(now, other)) - since);
  clock[source] = undefined;
}

/**
 * Pause credit belongs to the interval since the last progress, so a pause that fully elapsed
 * before this progress cannot be spent as credit after it.
 */
export function restartPauses(clock: ExecutionPauses, at: number): void {
  clock.pausedMs = 0;
  if (clock.waitingSince !== undefined) clock.waitingSince = at;
  if (clock.heldSince !== undefined) clock.heldSince = at;
}
