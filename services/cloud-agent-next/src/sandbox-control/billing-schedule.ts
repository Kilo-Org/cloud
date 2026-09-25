/**
 * Durable, per-callback schedule table for the control DO's Vercel billing
 * continuation. It never calls `setAlarm`/`deleteAlarm`: the control alarm is
 * owned by `control-alarm.ts`, and every mutation here triggers the DO's
 * `recompose` callback instead.
 *
 * Storage is the source of truth. `load` hydrates once before the first
 * compose can read the table, "not loaded" is distinct from "empty", and a load
 * failure leaves the table not loaded so the next attempt re-reads.
 */
export const VERCEL_BILLING_SCHEDULE_KEY = 'vercel-billing:schedule:v1';

export type BillingScheduleEntry = {
  dueAtMs: number;
  /** A dispatch retry must not run before this time, even if `dueAtMs` is past. */
  retryNotBeforeMs?: number;
  payload?: unknown;
};

export type BillingScheduleEntries = Record<string, BillingScheduleEntry>;

export type DueBillingSchedule = { callback: string; dueAtMs: number; payload?: unknown };

export type BillingScheduleStorage = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
};

export type BillingScheduleDeps = {
  storage: BillingScheduleStorage;
  recompose: () => Promise<void>;
  now?: () => number;
};

/**
 * The time an entry needs the alarm. Composition must arm it even when it is
 * not yet dispatchable, so it uses the entry's effective wake time: its due
 * time, pushed out by any delivery backoff. A future-dated or deferred
 * continuation therefore keeps the alarm armed instead of being dropped.
 */
function effectiveWakeAtMs(entry: BillingScheduleEntry): number {
  return entry.retryNotBeforeMs === undefined
    ? entry.dueAtMs
    : Math.max(entry.dueAtMs, entry.retryNotBeforeMs);
}

/** An entry is dispatchable only when both its due time and any retry bound are due. */
function isEligible(entry: BillingScheduleEntry, nowMs: number): boolean {
  return effectiveWakeAtMs(entry) <= nowMs;
}

function earliestEffectiveWakeAtMs(table: BillingScheduleEntries): number | null {
  let earliest: number | null = null;
  for (const entry of Object.values(table)) {
    const wakeAtMs = effectiveWakeAtMs(entry);
    if (earliest === null || wakeAtMs < earliest) earliest = wakeAtMs;
  }
  return earliest;
}

function eligibleEntries(table: BillingScheduleEntries, nowMs: number): DueBillingSchedule[] {
  const due: DueBillingSchedule[] = [];
  for (const [callback, entry] of Object.entries(table)) {
    if (!isEligible(entry, nowMs)) continue;
    due.push(
      entry.payload === undefined
        ? { callback, dueAtMs: entry.dueAtMs }
        : { callback, dueAtMs: entry.dueAtMs, payload: entry.payload }
    );
  }
  return due;
}

export class BillingScheduleTable {
  private table: BillingScheduleEntries | undefined;
  private loadPromise: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private composePromise: Promise<void> | undefined;
  private composeDirty = false;
  private readonly now: () => number;

  constructor(private readonly deps: BillingScheduleDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Serialize table reads and writes; never holds `recompose`. */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Hydrate the table exactly once. Concurrent callers share one read. A failed
   * read propagates and leaves `table` unset, so a retry re-reads.
   */
  async load(): Promise<void> {
    if (this.table !== undefined) return;
    if (this.loadPromise) return this.loadPromise;
    const read = (async () => {
      const stored =
        (await this.deps.storage.get<BillingScheduleEntries>(VERCEL_BILLING_SCHEDULE_KEY)) ?? {};
      this.table = stored;
    })();
    this.loadPromise = read;
    try {
      await read;
    } finally {
      if (this.loadPromise === read) this.loadPromise = undefined;
    }
  }

  private async loadedTable(): Promise<BillingScheduleEntries> {
    if (this.table === undefined) await this.load();
    if (this.table === undefined) throw new Error('Vercel billing schedule table failed to load');
    return this.table;
  }

  /**
   * Synchronous, non-enqueuing read of the loaded table. `undefined` means not
   * loaded; `null` means loaded with no entry. Otherwise it is the minimum
   * effective wake time over every entry, including future and deferred ones.
   */
  snapshotEarliestDue(): number | null | undefined {
    if (this.table === undefined) return undefined;
    return earliestEffectiveWakeAtMs(this.table);
  }

  /**
   * One in-flight compose pass. A mutation that finds a pass running sets a dirty
   * bit and returns the outer pass instead of enqueuing a nested recompose; the
   * loop that owns the pass runs one more `recompose`.
   */
  private compose(): Promise<void> {
    if (this.composePromise) {
      this.composeDirty = true;
      return this.composePromise;
    }
    this.composePromise = this.runComposePass();
    return this.composePromise;
  }

  private async runComposePass(): Promise<void> {
    try {
      do {
        this.composeDirty = false;
        await this.deps.recompose();
      } while (this.composeDirty);
    } finally {
      // Clear synchronously with the loop exit so a later mutation cannot set the
      // dirty bit against an already-finished pass.
      this.composePromise = undefined;
    }
  }

  /** Persist, update the in-memory table, then run the compose pass this write owns. */
  async schedule(callback: string, dueAtMs: number, payload?: unknown): Promise<void> {
    await this.run(async () => {
      const table = await this.loadedTable();
      const next: BillingScheduleEntries = { ...table };
      next[callback] = payload === undefined ? { dueAtMs } : { dueAtMs, payload };
      await this.deps.storage.put(VERCEL_BILLING_SCHEDULE_KEY, next);
      this.table = next;
    });
    await this.compose();
  }

  /**
   * Arm a continuation without clobbering an existing matching one. Unlike
   * `schedule`, an entry for the same payload keeps its due time and any
   * delivery backoff. The no-clobber decision runs inside the table queue, so a
   * concurrent `markDue`/`deferRetry` is observed rather than overwritten.
   */
  async ensure(callback: string, dueAtMs: number, payload?: unknown): Promise<void> {
    await this.run(async () => {
      const table = await this.loadedTable();
      if (table[callback]?.payload === payload) return;
      const next: BillingScheduleEntries = { ...table };
      next[callback] = payload === undefined ? { dueAtMs } : { dueAtMs, payload };
      await this.deps.storage.put(VERCEL_BILLING_SCHEDULE_KEY, next);
      this.table = next;
    });
    await this.compose();
  }

  /**
   * Move an existing continuation to its settlement due time. Never inserts an
   * entry, so a callback that was never armed is not created here. An existing
   * delivery backoff is preserved: a failed delivery sets `retryNotBeforeMs` and
   * a later settlement must not make it immediately dispatchable again.
   */
  async markDue(callback: string, payload: unknown, dueAtMs: number): Promise<void> {
    await this.run(async () => {
      const table = await this.loadedTable();
      const current = table[callback];
      if (current === undefined) return;
      if (current.payload !== payload) return;
      const next: BillingScheduleEntries = { ...table, [callback]: { ...current, dueAtMs } };
      await this.deps.storage.put(VERCEL_BILLING_SCHEDULE_KEY, next);
      this.table = next;
    });
    await this.compose();
  }

  /** Bound the next dispatch of a matching entry without changing its due time. */
  async deferRetry(callback: string, payload: unknown, notBeforeMs: number): Promise<void> {
    await this.run(async () => {
      const table = await this.loadedTable();
      const current = table[callback];
      if (current === undefined) return;
      if (current.payload !== payload) return;
      const next: BillingScheduleEntries = {
        ...table,
        [callback]: { ...current, retryNotBeforeMs: notBeforeMs },
      };
      await this.deps.storage.put(VERCEL_BILLING_SCHEDULE_KEY, next);
      this.table = next;
    });
    await this.compose();
  }

  /** Remove a matching entry. A supplied payload must match the stored one. */
  async remove(callback: string, payload?: unknown): Promise<void> {
    await this.run(async () => {
      const table = await this.loadedTable();
      const current = table[callback];
      if (current === undefined) return;
      if (payload !== undefined && current.payload !== payload) return;
      const next: BillingScheduleEntries = { ...table };
      delete next[callback];
      await this.deps.storage.put(VERCEL_BILLING_SCHEDULE_KEY, next);
      this.table = next;
    });
    await this.compose();
  }

  /** Eligible entries without removing them. */
  async dueEntries(): Promise<DueBillingSchedule[]> {
    return this.run(async () => eligibleEntries(await this.loadedTable(), this.now()));
  }

  /** Remove a claimed entry only when its due time and payload still match. */
  async completeDue(claimed: DueBillingSchedule): Promise<void> {
    await this.run(async () => {
      const table = await this.loadedTable();
      const current = table[claimed.callback];
      if (current === undefined) return;
      if (current.dueAtMs !== claimed.dueAtMs) return;
      if (current.payload !== claimed.payload) return;
      const next: BillingScheduleEntries = { ...table };
      delete next[claimed.callback];
      await this.deps.storage.put(VERCEL_BILLING_SCHEDULE_KEY, next);
      this.table = next;
    });
    await this.compose();
  }
}
