/* eslint-disable max-lines, max-assertions, vitest/max-expects -- the hold's contract is one table of cases over one fake: split it and the ordering rules stop being readable side by side; the cases assert cancel-before-suggest, so several expects per case are the point. */
/* eslint-disable require-await, @typescript-eslint/require-await -- fake browser APIs are async by contract; each records a call and resolves. */
/* eslint-disable jest/no-hooks, vitest/no-hooks, vitest/require-top-level-describe -- fake timers must be installed per case and restored after it. */
/* eslint-disable vitest/prefer-strict-equal -- the fake's ordering strings are primitives; deep equality says what `toStrictEqual` would say for a `string[]`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTION_WAIT_MS,
  createDownloadHold,
  targetOf,
  TRIPWIRE_MS,
} from './browser-download-hold';
import type { ApprovalNeed, DownloadHoldItem, DownloadStep } from './browser-download-hold';
import { DOWNLOAD_HOLD_STATE_KEY, startDownloadHold } from './browser-download-hold-host';
import { installDownloadHoldOnGrant } from './browser-download-hold-listener';

const page = 'https://app.example/reports';

const step: DownloadStep = {
  argumentHash: 'hash-1',
  description: "click on 'Download report'",
  noun: 'click',
  origin: 'https://app.example',
  session: 'session-1',
  tabId: 7,
  toolName: 'browser_click',
};

type Suggest = (override?: { readonly filename?: string }) => void;
type Listener = (item: DownloadHoldItem, suggest: Suggest) => boolean | undefined;

/** What one `onDeterminingFilename` dispatch answered. */
interface EmissionAnswer {
  readonly deferred: boolean;
  readonly settled: Promise<void>;
  readonly suggested: () => boolean;
}

/** The `chrome.downloads` fake: one event, one cancel, one search, and the order they were called in. */
interface FakeDownloads {
  readonly api: {
    readonly cancel: (itemId: number) => Promise<void>;
    readonly erase: () => Promise<void>;
    readonly onDeterminingFilename: { readonly addListener: (listener: Listener) => void };
    readonly search: (query: { readonly id?: number }) => Promise<readonly DownloadHoldItem[]>;
  };
  readonly globals: {
    readonly downloads: () => FakeDownloads['api'];
    readonly permissions: () => {
      readonly onAdded: {
        readonly addListener: (
          listener: (added: { readonly permissions?: string[] }) => void
        ) => void;
      };
    };
  };
  readonly grant: (permissions: readonly string[]) => void;
  readonly listenerCount: () => number;
  readonly order: string[];
  readonly refuseCancel: () => void;
  readonly run: (item: DownloadHoldItem) => EmissionAnswer;
  readonly searchThrows: () => void;
  readonly states: Map<number, string>;
}

/**
 * A `chrome.downloads` fake whose `onDeterminingFilename` records the order of
 * `cancel`, `search`, `erase` and `suggest`: the whole contract is that order.
 */
const makeDownloads = (): FakeDownloads => {
  const order: string[] = [];
  const states = new Map<number, string>();
  const listeners: Listener[] = [];
  const grantListeners: ((added: { readonly permissions?: string[] }) => void)[] = [];
  let cancelRefused = false;
  let searchThrows = false;

  const api = {
    cancel: async (itemId: number): Promise<void> => {
      order.push('cancel');

      if (cancelRefused) {
        throw new Error('the browser refused the cancel');
      }

      // A real cancel is a no-op on a terminal item: it never rewrites what the item already became.
      if (!states.has(itemId)) {
        states.set(itemId, 'interrupted');
      }
    },
    erase: async (): Promise<void> => {
      order.push('erase');
    },
    onDeterminingFilename: {
      addListener: (listener: Listener): void => {
        listeners.push(listener);
      },
    },
    search: async (query: { readonly id?: number }): Promise<readonly DownloadHoldItem[]> => {
      order.push('search');

      if (searchThrows) {
        throw new Error('the browser would not search');
      }

      const state = query.id === undefined ? undefined : states.get(query.id);

      return query.id === undefined || state === undefined ? [] : [{ id: query.id, state }];
    },
  };

  return {
    api,
    /** The `DownloadHoldGlobals` a host reads, over this fake. */
    globals: {
      downloads: () => api,
      permissions: () => ({
        onAdded: {
          addListener: (listener: (added: { readonly permissions?: string[] }) => void): void => {
            grantListeners.push(listener);
          },
        },
      }),
    },
    grant: (permissions: readonly string[]): void => {
      for (const listener of grantListeners) {
        listener({ permissions: [...permissions] });
      }
    },
    listenerCount: (): number => listeners.length,
    order,
    refuseCancel: (): void => {
      cancelRefused = true;
    },
    /** One `onDeterminingFilename` dispatch, and what the listener answered. */
    run: (item: DownloadHoldItem) => {
      const listener = listeners.at(-1);

      if (listener === undefined) {
        throw new Error('no listener registered');
      }

      let suggested = false;
      const { promise, resolve } = Promise.withResolvers<void>();
      const deferred = listener(item, () => {
        if (suggested) {
          throw new Error('suggest was called twice for one item');
        }

        suggested = true;
        order.push('suggest');
        resolve();
      });

      return { deferred: deferred === true, settled: promise, suggested: () => suggested };
    },
    searchThrows: (): void => {
      searchThrows = true;
    },
    states,
  };
};

/** The `storage.session` fake: one value per key, plus a switch that holds its read open. */
interface FakeStorage {
  readonly getItem: (key: string) => Promise<unknown>;
  readonly keys: string[];
  readonly release: () => void;
  readonly setItem: (key: string, value: unknown) => Promise<void>;
  readonly store: () => unknown;
}

/** A `storage.session` stand-in: one value per key, and optionally a deferred read for the hydration race. */
const makeStorage = ({
  deferred = false,
  initial,
}: {
  readonly deferred?: boolean;
  readonly initial?: unknown;
}): FakeStorage => {
  const keys: string[] = [];
  const values = new Map<string, unknown>();
  const { promise, resolve } = Promise.withResolvers<void>();

  if (initial !== undefined) {
    values.set(DOWNLOAD_HOLD_STATE_KEY, initial);
  }

  return {
    getItem: async (key: string): Promise<unknown> => {
      keys.push(key);

      if (deferred) {
        await promise;
      }

      return values.get(key);
    },
    keys,
    release: (): void => {
      resolve();
    },
    setItem: async (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
    },
    store: (): unknown => values.get(DOWNLOAD_HOLD_STATE_KEY),
  };
};

const agentTab = (
  overrides: { readonly page?: string; readonly session?: string; readonly tabId?: number } = {}
) => ({
  page: overrides.page ?? page,
  session: overrides.session ?? 'session-1',
  step,
  tabId: overrides.tabId ?? 7,
});

const armedNeed = (overrides: {
  readonly session?: string;
  readonly tabId?: number;
  readonly url: string;
}): ApprovalNeed => ({
  expiresAt: Date.now() + 60_000,
  kind: 'armed',
  session: overrides.session ?? 'session-1',
  step,
  tabId: overrides.tabId ?? 7,
  target: targetOf(overrides.url),
});

/** A hold over the fake, with the reports it queued in the order it queued them. */
const makeHold = (downloads: FakeDownloads) => {
  const reports: string[] = [];
  const hold = createDownloadHold({
    cancel: downloads.api.cancel,
    erase: downloads.api.erase,
    onReport: report => {
      reports.push(`${report.kept ? 'may-have-saved' : 'stopped'}:${report.filename}`);
    },
    search: async itemId => downloads.api.search({ id: itemId }),
  });

  return { hold, reports };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the listener', () => {
  it('registers exactly one listener, even after the download grant fires twice', () => {
    const downloads = makeDownloads();
    let handled = 0;

    installDownloadHoldOnGrant({
      downloads: downloads.globals.downloads,
      handle: () => {
        handled += 1;

        return false;
      },
      permissions: downloads.globals.permissions(),
    });
    downloads.grant(['downloads']);
    downloads.grant(['downloads']);

    expect(downloads.listenerCount()).toBe(1);

    downloads.run({ id: 1 });
    expect(handled).toBe(1);
  });

  it('suggests exactly once for an approved item', () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));

    const emission = hold.handle(
      { id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' },
      () => {
        downloads.order.push('suggest');
      }
    );

    expect(emission).toBe(false);
    expect(downloads.order).toEqual(['suggest']);
  });
});

describe('navigate expectations', () => {
  const attachment = 'https://app.example/reports/q4.pdf';
  const unreferred = { id: 1, url: attachment };

  it('owns and blocks an unreferred, unannounced item during a live navigate expectation', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());
    hold.navigate({
      attempt: 'attempt-1',
      session: 'session-1',
      tabId: 7,
      until: Date.now() + 5000,
      url: attachment,
    });

    // `block` cancels before `suggest`, so its answer is owed: the emission defers and the stop settles on the microtask.
    expect(
      hold.handle(unreferred, () => {
        downloads.order.push('suggest');
      })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(downloads.order).toContain('cancel');
    expect(reports).toStrictEqual(['stopped:q4.pdf']);
  });

  it('passes the same item through as foreign when no expectation is live on its tab', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());

    // No tie at all: the hold waits the attribution bound for an announcement, then leaves the file to its owner.
    hold.handle(unreferred, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(ATTRIBUTION_WAIT_MS + 1);

    expect(downloads.order).toStrictEqual(['suggest']);
    expect(reports).toStrictEqual([]);
  });

  it('lets an expired expectation fall away, so a later file is the user’s', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());
    hold.navigate({
      attempt: 'attempt-1',
      session: 'session-1',
      tabId: 7,
      until: Date.now() + 10,
      url: attachment,
    });
    await vi.advanceTimersByTimeAsync(50);

    hold.handle({ id: 2, url: attachment }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(ATTRIBUTION_WAIT_MS + 1);

    expect(downloads.order).toStrictEqual(['suggest']);
    expect(reports).toStrictEqual([]);
  });
});

describe('foreign downloads', () => {
  it('passes another extension’s download through at once', () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());

    expect(
      hold.handle(
        { byExtensionId: 'other', id: 1, referrer: page, url: 'https://app.example/x.pdf' },
        () => {
          downloads.order.push('suggest');
        }
      )
    ).toBe(false);
    expect(downloads.order).toEqual(['suggest']);
  });

  it('passes a download through at once when no agent tab is registered', () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    expect(
      hold.handle({ id: 1, referrer: page, url: 'https://app.example/x.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(downloads.order).toEqual(['suggest']);
  });

  it('leaves a file another page of the agent tab’s origin started to the user', () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());

    // The agent's tab is on /reports; the user's own tab is on /user, same origin. The referrer is the document
    // That started the file, so the origin alone must not claim it.
    expect(
      hold.handle(
        { id: 3, referrer: 'https://app.example/user', url: 'https://app.example/assets/user.txt' },
        () => {
          downloads.order.push('suggest');
        }
      )
    ).toBe(false);
    expect(downloads.order).toEqual(['suggest']);
    expect(reports).toStrictEqual([]);
  });

  it('passes a user download on another tab through untouched during an approved call', () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));

    expect(
      hold.handle(
        { id: 2, referrer: 'https://other.example/page', url: 'https://other.example/file.zip' },
        () => {
          downloads.order.push('suggest');
        }
      )
    ).toBe(false);
    expect(downloads.order).toEqual(['suggest']);
    expect(hold.tracked(2)).toBeUndefined();
  });
});

describe('a refused download', () => {
  it('cancels before it suggests, and reports the file as stopped', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: 'https://app.example/reports/other.pdf' }));

    expect(
      hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(downloads.order.indexOf('cancel')).toBeLessThan(downloads.order.indexOf('suggest'));
    expect(reports).toEqual(['stopped:q4.pdf']);
    expect(hold.tracked(1)?.kind).toBe('blocked');
  });

  it('reports a file as possibly saved when the cancel rejects, and still suggests', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    downloads.refuseCancel();
    hold.tab(agentTab());

    hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(reports).toEqual(['may-have-saved:q4.pdf']);
    expect(downloads.order).toContain('suggest');
  });

  it('reports a file as possibly saved when it had already completed', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    downloads.states.set(1, 'complete');
    hold.tab(agentTab());

    hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(reports).toEqual(['may-have-saved:q4.pdf']);
  });

  it('reports a file as possibly saved when the browser cannot describe it', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    downloads.searchThrows();
    hold.tab(agentTab());

    hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(reports).toEqual(['may-have-saved:q4.pdf']);
  });
});

describe('the approved repeat', () => {
  it('keeps exactly its file and refuses a second one from the same gesture', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));

    expect(
      hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(hold.tracked(1)?.kind).toBe('allowed');
    expect(hold.needOf('session-1')?.kind).toBe('spent');

    hold.handle({ id: 2, referrer: page, url: 'https://app.example/reports/q4-copy.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(hold.tracked(1)?.kind).toBe('allowed');
    expect(hold.tracked(2)?.kind).toBe('blocked');
    expect(reports).toEqual(['stopped:q4-copy.pdf']);
  });

  it('survives 30 s between the refusal and the approval', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(hold.needOf('session-1')?.kind).toBe('armed');
    expect(
      hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(hold.tracked(1)?.kind).toBe('allowed');
  });

  it('forgets an approval once its token’s lifetime is over', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));

    await vi.advanceTimersByTimeAsync(61_000);

    expect(hold.needOf('session-1')).toBeUndefined();
  });
});

describe('an unattributable download', () => {
  it('waits no longer than the attribution bound, then passes through', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());

    const answered: string[] = [];
    const startedAt = Date.now();

    hold.handle({ id: 1, url: 'https://app.example/reports/q4.pdf' }, () => {
      answered.push('suggest');
    });
    expect(answered).toEqual([]);

    await vi.advanceTimersByTimeAsync(ATTRIBUTION_WAIT_MS + 20);

    expect(answered).toEqual(['suggest']);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(ATTRIBUTION_WAIT_MS + 20);
  });

  it('is claimed by the announcement its tab sent first', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());
    hold.announce({
      suggestedFilename: 'q4.pdf',
      tabId: 7,
      url: 'https://app.example/reports/q4.pdf',
    });

    hold.handle({ id: 1, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(hold.tracked(1)?.kind).toBe('blocked');
    expect(downloads.order).toContain('cancel');
  });

  it('reports an announcement no item ever claimed as possibly saved', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());
    hold.announce({
      suggestedFilename: 'q4.pdf',
      tabId: 7,
      url: 'https://app.example/reports/q4.pdf',
    });

    await vi.advanceTimersByTimeAsync(TRIPWIRE_MS + 20);

    expect(reports).toEqual(['may-have-saved:q4.pdf']);
  });

  it('reports an announcement whose item was claimed by nobody as possibly saved, once', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());
    hold.announce({
      suggestedFilename: 'q4.pdf',
      tabId: 7,
      url: 'https://app.example/reports/q4.pdf',
    });
    hold.announce({
      suggestedFilename: 'q4.pdf',
      tabId: 7,
      url: 'https://app.example/reports/q4.pdf',
    });

    await vi.advanceTimersByTimeAsync(TRIPWIRE_MS + 20);

    expect(reports).toEqual(['may-have-saved:q4.pdf']);
  });
});

describe('the recorded state', () => {
  const startHost = (downloads: FakeDownloads, storage: FakeStorage) =>
    startDownloadHold({
      downloads: downloads.globals.downloads,
      permissions: downloads.globals.permissions,
      sessionStorage: () => storage,
    });

  it('rehydrates needs and reports from storage.session after a worker restart', async () => {
    const storage = makeStorage({});
    const first = makeDownloads();
    const firstHold = startHost(first, storage);

    firstHold.tab(agentTab());
    firstHold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));

    // A refused file, so the record carries a report the next worker has to hand back.
    firstHold.handle(
      { id: 1, referrer: page, url: 'https://app.example/reports/other.pdf' },
      () => {
        first.order.push('suggest');
      }
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.keys).toContain(DOWNLOAD_HOLD_STATE_KEY);
    expect(storage.store()).toBeDefined();

    const second = makeDownloads();
    const secondHold = startHost(second, storage);

    await vi.advanceTimersByTimeAsync(0);

    // The restored approval is the same one: the item it names is allowed.
    secondHold.handle({ id: 9, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      second.order.push('suggest');
    });
    expect(second.order).toContain('suggest');

    expect(
      secondHold.drain('session-1').map(report => `${String(report.kept)}:${report.filename}`)
    ).toEqual(['false:other.pdf']);
    expect(secondHold.drain('session-1')).toEqual([]);
  });

  it('keeps what this worker decided when a slower record would say otherwise', async () => {
    const storage = makeStorage({
      deferred: true,
      initial: { 'session-1': { owed: [], tabs: [] } },
    });
    const downloads = makeDownloads();
    const hold = startHost(downloads, storage);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));

    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    // The newer approval stands: the record's older view never replaced it.
    expect(hold.needOf('session-1')?.kind).toBe('armed');
    hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    expect(downloads.order).toContain('suggest');
  });
});

describe('a sign-gated settle', () => {
  const attachment = 'https://app.example/reports/q4.pdf';
  const sign = (signed: () => boolean) => signed;

  it('waits for the item a sign announced, and the call decides the file it names', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);
    let signed = false;

    hold.tab(agentTab());

    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: sign(() => signed),
      since: Date.now(),
      timeoutMs: 1500,
    });

    // The browser announces the file inside the grace, and creates the item 300 ms in.
    await vi.advanceTimersByTimeAsync(20);
    signed = true;
    await vi.advanceTimersByTimeAsync(300);

    hold.handle({ id: 1, referrer: page, url: attachment }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(settled).resolves.toBe('decided');
    // The item's own decision is the block path every other case covers; here the point is that the call waited
    // Past the short grace for the item its sign announced.
    expect(signed).toBe(true);
  });

  it('answers an unsigned call after the short grace, without waiting for an item', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());

    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: sign(() => false),
      since: Date.now(),
      timeoutMs: 1500,
    });

    await vi.advanceTimersByTimeAsync(60);

    await expect(settled).resolves.toBe('no_sign');
  });

  it('answers a signed call whose item never arrives as waiting, never as decided', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());

    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: sign(() => true),
      since: Date.now(),
      timeoutMs: 1500,
    });

    await vi.advanceTimersByTimeAsync(1600);

    // Nothing was decided, and the hold invented no report: the caller decides what the file may have become.
    await expect(settled).resolves.toBe('waiting_for_item');
    expect(reports).toStrictEqual([]);
  });
});
