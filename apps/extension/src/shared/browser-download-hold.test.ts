/* eslint-disable max-lines, max-assertions, vitest/max-expects -- the hold's contract is one table of cases over one fake: split it and the ordering rules stop being readable side by side; the cases assert cancel-before-suggest, so several expects per case are the point. */
/* eslint-disable require-await, @typescript-eslint/require-await -- fake browser APIs are async by contract; each records a call and resolves. */
/* eslint-disable jest/no-hooks, vitest/no-hooks, vitest/require-top-level-describe -- fake timers must be installed per case and restored after it. */
/* eslint-disable vitest/prefer-strict-equal -- the fake's ordering strings are primitives; deep equality says what `toStrictEqual` would say for a `string[]`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ATTRIBUTION_WAIT_MS,
  createDownloadHold,
  SETTLE_QUIET_MS,
  targetOf,
  TRIPWIRE_MS,
} from './browser-download-hold';
import type {
  ApprovalNeed,
  DownloadHold,
  DownloadHoldItem,
  DownloadSettle,
  DownloadSign,
  DownloadStep,
} from './browser-download-hold';
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
    readonly extensionOrigin: () => string;
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
  readonly refuseRegistrationOnce: () => void;
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
  let registrationRefused = false;
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
        // The browser can refuse the registration itself: a throwing `addListener` installs nothing.
        if (registrationRefused) {
          registrationRefused = false;
          throw new Error('the browser refused the registration');
        }

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
      extensionOrigin: () => 'chrome-extension://kilo-test-extension-id/',
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
    refuseRegistrationOnce: (): void => {
      registrationRefused = true;
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

/** The `storage.session` fake: one value per key, plus a switch that holds its read open and one that refuses it. */
interface FakeStorage {
  readonly allowReads: () => void;
  readonly getItem: (key: string) => Promise<unknown>;
  readonly keys: string[];
  /** The session names the last written record holds: what a restart would restore. */
  readonly recordKeys: () => string[];
  readonly refuseReads: () => void;
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
  let reading = false;

  if (initial !== undefined) {
    values.set(DOWNLOAD_HOLD_STATE_KEY, initial);
  }

  return {
    allowReads: (): void => {
      reading = false;
    },
    getItem: async (key: string): Promise<unknown> => {
      keys.push(key);

      if (reading) {
        // The area itself refused the read: what it holds is unknown to the caller, exactly as a woken worker finds it.
        throw new Error('session storage is unavailable');
      }

      if (deferred) {
        await promise;
      }

      return values.get(key);
    },
    keys,
    recordKeys: (): string[] => {
      const value = values.get(DOWNLOAD_HOLD_STATE_KEY);
      const parsed = z
        .object({})
        .catchall(z.unknown())
        .safeParse(value ?? {});

      return parsed.success ? Object.keys(parsed.data) : [];
    },
    refuseReads: (): void => {
      reading = true;
    },
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
  /**
   * The defect this covers: a throw needs `onDeterminingFilename` to exist, and in Chrome the event exists only after
   * `downloads` is granted — the state in which `permissions.onAdded` never fires again. A refused startup registration
   * therefore had no edge to retry on, and the profile stayed unguarded. The call about to start a download asks for
   * the install again, and that is the case this drives: no grant afterwards, only a call.
   */
  it('retries the registration from the call that is about to start a download', async () => {
    // The install flag lives in the module, and every other case in this file has already set it, so only a fresh
    // Copy of the module starts uninstalled. A static import is the one instance the whole file shares, so this case
    // Cannot use it: it exercises the module-loading boundary itself.
    vi.resetModules();
    const { installDownloadHoldOnGrant: installFresh } =
      await import('./browser-download-hold-listener');
    const downloads = makeDownloads();
    let handled = 0;

    // The grant is already in place, which is the only way the event exists for the registration to throw from.
    downloads.refuseRegistrationOnce();
    const retry = installFresh({
      downloads: downloads.globals.downloads,
      handle: () => {
        handled += 1;

        return false;
      },
      permissions: downloads.globals.permissions(),
    });

    expect(downloads.listenerCount()).toBe(0);

    // No grant follows: the call itself is the only thing left before the file.
    retry();
    expect(downloads.listenerCount()).toBe(1);

    downloads.run({ id: 1 });
    expect(handled).toBe(1);

    // And the retry stays a no-op once the listener is in: one download, one registration.
    retry();
    expect(downloads.listenerCount()).toBe(1);
  });

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

  /**
   * The defect this covers: a cross-origin attachment's referrer is origin-only, so the exact page comparison never
   * matched the agent tab and `classify` called it foreign — the file was saved with no approval and no report.
   */
  it('owns a cross-origin attachment whose referrer carries only the origin', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());

    // Chrome's default policy reduces a cross-origin referrer to `origin/`: the path was withheld, not absent.
    expect(
      hold.handle(
        { id: 4, referrer: 'https://app.example/', url: 'https://files.example/q4.pdf' },
        () => {
          downloads.order.push('suggest');
        }
      )
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(downloads.order.indexOf('cancel')).toBeLessThan(downloads.order.indexOf('suggest'));
    expect(reports).toStrictEqual(['stopped:q4.pdf']);
  });

  it('leaves an origin-only referrer naming no agent tab’s origin to the user', () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());

    expect(
      hold.handle(
        { id: 5, referrer: 'https://other.example/', url: 'https://files.example/q4.pdf' },
        () => {
          downloads.order.push('suggest');
        }
      )
    ).toBe(false);
    expect(downloads.order).toEqual(['suggest']);
    expect(reports).toStrictEqual([]);
  });

  /**
   * The module header promises an announcement is the strongest attribution, ahead of the referrer. An announcement
   * that names the file on an agent tab therefore decides the download even when its referrer points elsewhere.
   */
  it('owns a file its own announcement claimed, whatever the referrer says', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());
    hold.announce({
      suggestedFilename: 'q4.pdf',
      tabId: 7,
      url: 'https://files.example/q4.pdf',
    });

    // A referrer that names no agent tab at all: without the announcement this would pass as another page's file.
    expect(
      hold.handle(
        { id: 6, referrer: 'https://other.example/page', url: 'https://files.example/q4.pdf' },
        () => {
          downloads.order.push('suggest');
        }
      )
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(downloads.order.indexOf('cancel')).toBeLessThan(downloads.order.indexOf('suggest'));
    expect(reports).toStrictEqual(['stopped:q4.pdf']);
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

describe('a download announced after its own item', () => {
  it('is that settled file’s own event, so the tripwire never reports the file a second time', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());

    // The response only becomes a file after the call answered: the item is decided and reported first.
    hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(hold.tracked(1)?.kind).toBe('blocked');
    expect(hold.drain('session-1').map(one => one.filename)).toEqual(['q4.pdf']);

    // Chrome names the very same download a moment later: an announcement that arrives after the item it names.
    await vi.advanceTimersByTimeAsync(2000);
    hold.announce({
      guid: 'late',
      suggestedFilename: 'q4.pdf',
      tabId: 7,
      url: 'https://app.example/reports/q4.pdf',
    });
    await vi.advanceTimersByTimeAsync(TRIPWIRE_MS + 20);

    // The hold already answered for that file: no second, "may have been saved" report is owed for it.
    expect(hold.drain('session-1')).toEqual([]);
  });

  it('is that settled file’s own event even when the browser stamped it before the settle', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());

    // The item is decided at this instant, and the hold stamps it as settled then.
    hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(hold.tracked(1)?.kind).toBe('blocked');
    hold.drain('session-1');

    // The browser's own stamp can be a hair earlier than the moment the hold decided: `downloadWillBegin` and the
    // Item are dispatched from one browser event, and the stamp is read before the item reaches this listener. Two
    // Milliseconds earlier is still that same download — the ordering never decides whether a file is a second one.
    hold.announce({
      guid: 'earlier',
      startedAt: Date.now() - 2,
      suggestedFilename: 'q4.pdf',
      tabId: 7,
      url: 'https://app.example/reports/q4.pdf',
    });
    await vi.advanceTimersByTimeAsync(TRIPWIRE_MS + 20);

    // The hold already answered for that file, so the tripwire must not report it as possibly saved a second time.
    expect(hold.drain('session-1')).toEqual([]);
    expect(reports).toEqual(['stopped:q4.pdf']);
  });

  it('is a new file when the tab settled a different page, even under the same name', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());
    hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);
    hold.drain('session-1');

    // Another url under the same file name: a second download, and its announcement is the only record of it.
    hold.announce({
      guid: 'other',
      suggestedFilename: 'q4.pdf',
      tabId: 7,
      url: 'https://app.example/other/q4.pdf',
    });
    await vi.advanceTimersByTimeAsync(TRIPWIRE_MS + 20);

    expect(reports).toEqual(['stopped:q4.pdf', 'may-have-saved:q4.pdf']);
  });
});

describe('the recorded state', () => {
  const chromeOrigin = () => 'chrome-extension://kilo-test-extension-id/';
  const startChrome = (downloads: FakeDownloads, storage: FakeStorage): DownloadHold => {
    const hold = startDownloadHold({
      downloads: downloads.globals.downloads,
      extensionOrigin: chromeOrigin,
      permissions: downloads.globals.permissions,
      sessionStorage: () => storage,
    });

    if (hold === undefined) {
      throw new Error('expected Chrome to have a download hold');
    }

    return hold;
  };

  /**
   * The defect this covers: the host always returned a hold, so Firefox — which has no `onDeterminingFilename` at all —
   * was given one, the runtime picked the hold tier, and nothing was listening: the file was saved unreported.
   */
  it('returns no hold at all in a browser that cannot raise the event', () => {
    const firefox = makeDownloads();

    expect(
      startDownloadHold({
        downloads: firefox.globals.downloads,
        extensionOrigin: () => 'moz-extension://kilo-test-extension-id/',
        permissions: firefox.globals.permissions,
        sessionStorage: () => makeStorage({}),
      })
    ).toBeUndefined();

    // Chrome keeps its hold before the grant, because the grant is what makes the event exist there.
    expect(startChrome(makeDownloads(), makeStorage({}))).toBeDefined();
  });

  it('returns no hold when the browser will not name its own origin', () => {
    const downloads = makeDownloads();
    // `chrome.runtime.getURL` absent is what background.ts reads as no origin at all.
    const origin: string | undefined = undefined;

    expect(
      startDownloadHold({
        downloads: downloads.globals.downloads,
        extensionOrigin: () => origin,
        permissions: downloads.globals.permissions,
        sessionStorage: () => makeStorage({}),
      })
    ).toBeUndefined();
  });

  /**
   * The defect this covers, at the layer that reaches the browser: the host ignored `installDownloadHoldOnGrant`'s
   * result, so a registration the browser refused at startup was never tried again — and in Chrome no grant edge can
   * follow, because the refusal needs the event and the event needs the grant. The runtime sends `tab()` before every
   * download-capable call, so the host must retry there.
   */
  it('retries a refused registration when a call registers its tab', async () => {
    const downloads = makeDownloads();
    const storage = makeStorage({});
    // The install flag lives in the listener module and this file's other cases have set it, so this case needs fresh
    // Copies of both modules. A static import is the one instance the whole file shares, so it cannot serve here.
    vi.resetModules();
    const { startDownloadHold: startFresh } = await import('./browser-download-hold-host');

    downloads.refuseRegistrationOnce();

    const hold = startFresh({
      downloads: downloads.globals.downloads,
      extensionOrigin: () => 'chrome-extension://kilo-test-extension-id/',
      permissions: downloads.globals.permissions,
      sessionStorage: () => storage,
    });

    // The startup install was refused and installed nothing.
    expect(hold).toBeDefined();
    expect(downloads.listenerCount()).toBe(0);

    // The call that is about to start a download registers its tab, and that is what installs the listener.
    hold?.tab(agentTab());

    expect(downloads.listenerCount()).toBe(1);
  });

  it('rehydrates needs and reports from storage.session after a worker restart', async () => {
    const storage = makeStorage({});
    const first = makeDownloads();
    const firstHold = startChrome(first, storage);

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
    const secondHold = startChrome(second, storage);

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

  it('keeps the origin a step approval is bound to across a worker restart', async () => {
    const storage = makeStorage({});
    const first = makeDownloads();
    const firstHold = startChrome(first, storage);
    /** The step's own call ran in the tab's document; the approval it needs belongs to the element's frame. */
    const crossFrame = { ...step, boundOrigin: 'https://pay.example' };

    firstHold.tab({ ...agentTab(), step: crossFrame });
    firstHold.arm({
      ...armedNeed({ url: 'https://app.example/reports/q4.pdf' }),
      step: crossFrame,
    });
    await vi.advanceTimersByTimeAsync(0);

    const second = makeDownloads();
    const secondHold = startChrome(second, storage);

    await vi.advanceTimersByTimeAsync(0);

    // The restored tab and approval carry the origin the approval was bound to, which a file approval issued now
    // Binds, so its retry matches the binding the gate recomputes rather than the origin of the call.
    const restored = storage.store();
    expect(JSON.stringify(restored)).toContain('https://pay.example');
    expect(secondHold.needOf('session-1')?.step?.boundOrigin).toBe('https://pay.example');
  });

  /**
   * The behaviour this covers: the record is written whole, so a worker that did not get an answer from the area
   * leaves the stored value as its writer left it, and both the tabs and the approvals a live session holds stay in it
   * for the next boot. The live hold is still complete for the calls this worker answers.
   */
  it('leaves the stored record untouched when the area refuses the read', async () => {
    const attachment = 'https://app.example/reports/q4.pdf';
    const record = {
      'session-1': {
        need: armedNeed({ url: attachment }),
        owed: [
          {
            filename: 'earlier.txt',
            kept: false,
            since: 1,
            step,
            tabId: 9,
            url: 'https://app.example/reports/earlier.txt',
          },
        ],
        tabs: [{ page, session: 'session-1', step, tabId: 9 }],
      },
    };
    const storage = makeStorage({ initial: record });
    storage.refuseReads();
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    // The call that woke this worker registers its tab and arms an approval, and each of those queues a write.
    hold.tab(agentTab());
    hold.arm(armedNeed({ url: attachment }));
    hold.handle({ id: 1, referrer: page, url: attachment }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    // The record is exactly what the previous worker stored: a value this worker never read is not replaced.
    expect(storage.store()).toStrictEqual(record);
    expect(storage.recordKeys()).toStrictEqual(['session-1']);

    // The loss is the mirror's alone: the live hold still armed the approval and kept the file the call asked for.
    expect(downloads.order).toContain('suggest');
    expect(hold.tracked(1)?.kind).toBe('allowed');
  });

  /**
   * The defect this covers: a call registers its tab (and its approval) before the tool runs, and the host marked the
   * session as decided there. A record read still in flight was therefore skipped for that session, and the write the
   * call queued persisted only its own tab — erasing the session's other tabs, an approval a human had granted before
   * the worker slept, and the reports a previous worker queued.
   */
  it('merges the record into a session a call registered before the read landed', async () => {
    const otherTab = 'https://app.example/other';
    const attachment = 'https://app.example/reports/q4.pdf';
    const record = {
      'session-1': {
        need: armedNeed({ url: attachment }),
        owed: [
          {
            filename: 'earlier.txt',
            kept: false,
            since: 1,
            step,
            tabId: 9,
            url: 'https://app.example/reports/earlier.txt',
          },
        ],
        tabs: [{ page: otherTab, session: 'session-1', step, tabId: 9 }],
      },
    };
    const storage = makeStorage({ deferred: true, initial: record });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    // The call that woke the worker registers its own tab before the record has been read.
    hold.tab(agentTab());

    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    // Nothing the record held was erased: the other tab, the approval, and the queued report are all still there.
    expect(storage.recordKeys()).toStrictEqual(['session-1']);
    expect(hold.drain('session-1').map(one => `${String(one.kept)}:${one.filename}`)).toStrictEqual(
      ['false:earlier.txt']
    );
    expect(hold.needOf('session-1')?.kind).toBe('armed');

    // And the call's own tab is registered too, so a download on it is still the agent's.
    expect(
      hold.handle({ id: 1, referrer: page, url: attachment }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(downloads.order).toContain('suggest');
    expect(hold.tracked(1)?.kind).toBe('allowed');
  });

  /**
   * The defect this covers: the same registration race, read through the mirror. A download that starts on a tab the
   * record restored is attributed only if the restore kept it, so the erased tab is the missing half of the fix.
   */
  it('keeps the record’s other tab registered when a call registered its own first', async () => {
    const otherTab = 'https://app.example/other';
    const storage = makeStorage({
      deferred: true,
      initial: {
        'session-1': {
          need: armedNeed({ url: 'https://app.example/reports/q4.pdf' }),
          owed: [],
          tabs: [{ page: otherTab, session: 'session-1', step, tabId: 9 }],
        },
      },
    });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    hold.tab(agentTab());
    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    // A download on the restored tab is the agent's, exactly as it was before the worker slept.
    expect(
      hold.handle({ id: 1, referrer: otherTab, url: 'https://app.example/other/late.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(downloads.order).toContain('cancel');
  });

  /**
   * The defect this covers: the hold's `tab` replaces by tab id and its `arm` by session, and the live mirror entry of
   * a waking call only landed after this read. The record's older page, step and approval were therefore written over
   * what the call had just registered, so the call's download was attributed to the previous step and the file the
   * user had just approved was matched against an expired need and refused.
   */
  it('keeps the tab and the approval a waking call registered over the record’s older ones', async () => {
    const otherPage = 'https://app.example/previous';
    const attachment = 'https://app.example/reports/q4.pdf';
    const staleNeed: ApprovalNeed = {
      expiresAt: Date.now() - 1,
      kind: 'armed',
      session: 'session-1',
      step,
      tabId: 7,
      target: targetOf(attachment),
    };
    const storage = makeStorage({
      deferred: true,
      initial: {
        'session-1': {
          need: staleNeed,
          owed: [],
          tabs: [{ page: otherPage, session: 'session-1', step, tabId: 7 }],
        },
      },
    });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);
    const freshStep = {
      ...step,
      description: "click on 'Download invoice'",
      toolName: 'browser_click',
    };

    // The waking call registers its tab and arms the approval a human just gave, before the record is read.
    hold.tab({ ...agentTab(), step: freshStep });
    hold.arm({
      expiresAt: Date.now() + 60_000,
      kind: 'armed',
      session: 'session-1',
      step: freshStep,
      tabId: 7,
      target: targetOf(attachment),
    });

    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    // The call's own approval is the live one: the record's expired token never replaced it.
    expect(hold.needOf('session-1')?.kind).toBe('armed');

    expect(
      hold.handle({ id: 1, referrer: page, url: attachment }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(downloads.order).toContain('suggest');
    expect(hold.tracked(1)?.kind).toBe('allowed');
  });

  /**
   * The defect this covers: the applies ran after the restore and never consulted `closed`/`detached`, so a
   * registration queued before a close re-created the session — and one queued before a detach re-added the tab — and
   * the next worker restored a session that no longer existed.
   */
  it('lets a close during the read win over a queued registration', async () => {
    const storage = makeStorage({ deferred: true, initial: {} });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));
    hold.closeSession('session-1');

    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    // Nothing the closed session registered comes back, in the mirror or in the record.
    expect(storage.recordKeys()).toStrictEqual([]);
    expect(hold.needOf('session-1')).toBeUndefined();
    expect(
      hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(downloads.order).toStrictEqual(['suggest']);
  });

  it('lets a detach during the read win over a queued registration', async () => {
    const storage = makeStorage({ deferred: true, initial: {} });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    hold.tab(agentTab());
    hold.tab({ detach: 7 });

    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    // The forgotten tab is not re-registered by the queue — neither on its page nor on any other.
    expect(
      hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(downloads.order).toStrictEqual(['suggest']);

    // The record is empty, so only the queue could have brought the tab back: it must not be in the mirror either.
    expect(storage.recordKeys()).toStrictEqual([]);
  });

  it('keeps what this worker decided when a slower record would say otherwise', async () => {
    const storage = makeStorage({
      deferred: true,
      initial: { 'session-1': { owed: [], tabs: [] } },
    });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

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

  /**
   * The defect this covers: the armed need is the only thing the record kept, so a worker restarted inside the
   * token's lifetime re-armed an approval the first file had already spent, and a second file landed unanswered.
   */
  it('keeps a spent approval spent across a restart, so it is never armed twice', async () => {
    const storage = makeStorage({});
    const first = makeDownloads();
    const firstHold = startChrome(first, storage);
    const attachment = 'https://app.example/reports/q4.pdf';

    firstHold.tab(agentTab());
    firstHold.arm(armedNeed({ url: attachment }));
    // The record is read before the first decision: a waking download waits for it, and so does this test.
    await vi.advanceTimersByTimeAsync(0);

    // The approved file lands: the one file the approval bought is spent.
    expect(
      firstHold.handle({ id: 1, referrer: page, url: attachment }, () => {
        first.order.push('suggest');
      })
    ).toBe(false);
    expect(firstHold.needOf('session-1')?.kind).toBe('spent');

    const second = makeDownloads();
    const secondHold = startChrome(second, storage);

    await vi.advanceTimersByTimeAsync(0);

    // The restarted worker restored the spent need, not an armed one: a second file is refused, never let through.
    expect(secondHold.needOf('session-1')?.kind).toBe('spent');

    const download = secondHold.handle({ id: 2, referrer: page, url: attachment }, () => {
      second.order.push('suggest');
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(download).toBe(true);
    expect(second.order).toContain('cancel');
    expect(
      secondHold.drain('session-1').map(report => `${String(report.kept)}:${report.filename}`)
    ).toEqual(['false:q4.pdf']);
  });

  /**
   * The behaviour this covers: a spend reads the record once and merges it under the worker's mirror, so the stored
   * value carries the approval the file spent, even when this worker's startup read got no answer.
   */
  it('stores a spent approval when the spend’s own read answers, so it reads back as spent', async () => {
    const attachment = 'https://app.example/reports/q4.pdf';
    // Generation A stores an armed approval and the tab it belongs to.
    const storage = makeStorage({});
    const first = makeDownloads();
    const firstHold = startChrome(first, storage);

    firstHold.tab(agentTab());
    firstHold.arm(armedNeed({ url: attachment }));
    await vi.advanceTimersByTimeAsync(0);

    // Generation W gets no answer on its boot read, so it restores nothing and stores nothing.
    storage.refuseReads();
    const middle = makeDownloads();
    const middleHold = startChrome(middle, storage);

    middleHold.tab(agentTab());
    middleHold.arm(armedNeed({ url: attachment }));
    await vi.advanceTimersByTimeAsync(0);

    // The area answers again before a human's approval is spent: the spend's own read is the one that lands.
    storage.allowReads();
    middleHold.handle({ id: 1, referrer: page, url: attachment }, () => {
      middle.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    // The next boot reads the spent approval, so the file that approval already bought is refused with a report.
    const last = makeDownloads();
    const lastHold = startChrome(last, storage);

    await vi.advanceTimersByTimeAsync(0);

    expect(lastHold.needOf('session-1')?.kind).toBe('spent');
    expect(
      lastHold.handle({ id: 2, referrer: page, url: attachment }, () => {
        last.order.push('suggest');
      })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(last.order).toContain('cancel');
    expect(
      lastHold.drain('session-1').map(report => `${String(report.kept)}:${report.filename}`)
    ).toEqual(['false:q4.pdf']);
  });

  it('does not re-register a tab forgotten before the boot read when the spend’s own read lands', async () => {
    const attachment = 'https://app.example/reports/q4.pdf';
    const record = {
      'session-1': {
        need: armedNeed({ tabId: 9, url: attachment }),
        owed: [],
        tabs: [{ page, session: 'session-1', step, tabId: 9 }],
      },
    };
    const storage = makeStorage({ initial: record });
    storage.refuseReads();
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    // This worker forgets the tab before its boot read answers.
    hold.tab({ detach: 9 });
    await vi.advanceTimersByTimeAsync(0);

    // The spend's own read lands afterwards, and the record still lists tab 9.
    storage.allowReads();
    hold.tab(agentTab());
    hold.arm(armedNeed({ url: attachment }));
    hold.handle({ id: 1, referrer: page, url: attachment }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    // The spent approval is stored, and the forgotten tab is not put back by that merge.
    const written = z
      .object({})
      .catchall(z.object({ tabs: z.array(z.object({ tabId: z.number() })) }))
      .parse(storage.store());
    const stored = z
      .object({ tabs: z.array(z.object({ tabId: z.number() })) })
      .parse(written['session-1']);

    expect(stored.tabs.map(tab => tab.tabId)).not.toContain(9);
  });

  it('keeps the stored record untouched when the spend’s own read also fails', async () => {
    const attachment = 'https://app.example/reports/q4.pdf';
    const record = {
      'session-1': {
        need: armedNeed({ url: attachment }),
        owed: [],
        tabs: [{ page, session: 'session-1', step, tabId: 9 }],
      },
    };
    const storage = makeStorage({ initial: record });
    storage.refuseReads();
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    hold.tab(agentTab());
    hold.arm(armedNeed({ url: attachment }));
    await vi.advanceTimersByTimeAsync(0);
    hold.handle({ id: 1, referrer: page, url: attachment }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(0);

    // A retry that also fails still stores nothing: a write needs a record on this path too.
    expect(storage.store()).toStrictEqual(record);
  });

  /**
   * The defect this covers: the record was restored in the background, so a download whose event woke the worker was
   * classified against an empty hold — no agent tab, no approval — and its file was passed through as the user's.
   */
  it('decides a waking download only after the record is restored', async () => {
    const attachment = 'https://app.example/reports/q4.pdf';
    const record = {
      'session-1': {
        owed: [],
        tabs: [{ page, session: 'session-1', step, tabId: 7 }],
      },
    };
    const storage = makeStorage({ deferred: true, initial: record });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    const emission = hold.handle({ id: 1, referrer: page, url: attachment }, () => {
      downloads.order.push('suggest');
    });

    // The record has not landed: nothing may be answered yet, and the answer is owed to Chrome.
    expect(emission).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(downloads.order).toEqual([]);

    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    // The restored agent tab makes this the agent's file: cancelled before `suggest`, and reported.
    expect(downloads.order.indexOf('cancel')).toBeLessThan(downloads.order.indexOf('suggest'));
    expect(
      hold.drain('session-1').map(report => `${String(report.kept)}:${report.filename}`)
    ).toEqual(['false:q4.pdf']);
  });

  /**
   * The defect this covers: closing a session did not touch it, so a record read still in flight restored the closed
   * session's tabs — and a user's download on that page was attributed, cancelled and reported to nobody.
   */
  it('never resurrects a session closed before the record was read', async () => {
    const attachment = 'https://app.example/reports/q4.pdf';
    const record = {
      'session-1': {
        need: armedNeed({ url: attachment }),
        owed: [],
        tabs: [{ page, session: 'session-1', step, tabId: 7 }],
      },
    };
    const storage = makeStorage({ deferred: true, initial: record });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    hold.closeSession('session-1');
    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    // The closed session is gone from the record, and its tab is not registered: the file is the user's.
    expect(hold.needOf('session-1')).toBeUndefined();
    expect(storage.recordKeys()).toStrictEqual([]);
    expect(
      hold.handle({ id: 1, referrer: page, url: attachment }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(downloads.order).toEqual(['suggest']);
    expect(hold.drain('session-1')).toEqual([]);
  });

  /**
   * The defect this covers: a detached tab was edited out of the record only while it existed, so a tab read that was
   * still in flight re-registered a closed tab and its downloads were attributed to a session that left the page.
   */
  it('never re-registers a tab detached before the record was read', async () => {
    const attachment = 'https://app.example/reports/q4.pdf';
    const record = {
      'session-1': {
        owed: [],
        tabs: [{ page, session: 'session-1', step, tabId: 7 }],
      },
    };
    const storage = makeStorage({ deferred: true, initial: record });
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    hold.tab({ detach: 7 });
    storage.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      hold.handle({ id: 1, referrer: page, url: attachment }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(downloads.order).toEqual(['suggest']);
    expect(hold.drain('session-1')).toEqual([]);
  });

  /**
   * A registration that arrives after the record was read: the record holds a session's facts only while the session
   * is live, so this approval and this tab are not kept.
   */
  it('keeps nothing a closed session registers after the record was read', async () => {
    const storage = makeStorage({});
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    // The record is read, so a registration lands in the mirror and in the record from here on.
    await vi.advanceTimersByTimeAsync(0);

    hold.closeSession('session-1');
    hold.arm(armedNeed({ url: 'https://app.example/reports/q4.pdf' }));
    hold.tab(agentTab());
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.recordKeys()).toStrictEqual([]);
    expect(hold.needOf('session-1')).toBeUndefined();
    // Its tab is not the agent's any more, so a download there is the user's and passes untouched.
    expect(
      hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(false);
    expect(downloads.order).toStrictEqual(['suggest']);
    expect(hold.drain('session-1')).toEqual([]);
  });

  /**
   * The same rule for the writer a stop runs: a stopped file reports when its cancel and its look-up have answered, and
   * a session that had closed by then keeps no report.
   */
  it('keeps a report a stop queued after the close out of the record', async () => {
    const storage = makeStorage({});
    const downloads = makeDownloads();
    const hold = startChrome(downloads, storage);

    await vi.advanceTimersByTimeAsync(0);

    hold.tab(agentTab());

    // The stop's own awaits are still pending here: the cancel has been asked for, and the report is queued after the
    // Look-up that follows it.
    expect(
      hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
        downloads.order.push('suggest');
      })
    ).toBe(true);

    hold.closeSession('session-1');
    await vi.advanceTimersByTimeAsync(0);

    // The file was still stopped, and the record keeps nothing: a closed session has no entry.
    expect(downloads.order.indexOf('cancel')).toBeLessThan(downloads.order.indexOf('suggest'));
    expect(storage.recordKeys()).toStrictEqual([]);
  });
});

describe('a sign-gated settle', () => {
  const attachment = 'https://app.example/reports/q4.pdf';

  it('waits for the item a sign announced, and the call decides the file it names', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);
    let sign: DownloadSign = 'none';

    hold.tab(agentTab());

    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: () => sign,
      since: Date.now(),
      timeoutMs: 1500,
    });

    // The browser announces the file inside the grace, and creates the item 300 ms in.
    await vi.advanceTimersByTimeAsync(20);
    sign = 'download';
    await vi.advanceTimersByTimeAsync(300);

    hold.handle({ id: 1, referrer: page, url: attachment }, () => {
      downloads.order.push('suggest');
    });
    // The decision is written, and the call stays open for the gesture's other files until the window is quiet.
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS + 20);

    await expect(settled).resolves.toBe('decided');
    // The item's own decision is the block path every other case covers; here the point is that the call waited
    // Past the short grace for the item its sign announced.
    expect(sign).toBe('download');
  });

  it('answers an unsigned call after the short grace, without waiting for an item', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);

    hold.tab(agentTab());

    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: () => 'none',
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
      sign: () => 'download',
      since: Date.now(),
      timeoutMs: 1500,
    });

    await vi.advanceTimersByTimeAsync(1600);

    // Nothing was decided, and the hold invented no report: the caller decides what the file may have become.
    await expect(settled).resolves.toBe('waiting_for_item');
    expect(reports).toStrictEqual([]);
  });

  /**
   * The hold-tier form of the same race: a click's attachment response is a Document of the call's that the browser
   * has not answered, so the call may not answer "nothing happened" while it is outstanding. Only once that Document
   * is answered with no download does the call answer `no_sign`.
   */
  it('waits out a Document of its own that is still unanswered before answering no_sign', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);
    let sign: DownloadSign = 'pending';

    hold.tab(agentTab());

    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: () => sign,
      since: Date.now(),
      timeoutMs: 1500,
    });

    // The grace is long spent, and the call still has a Document in flight: it is not "no download".
    let outcome: DownloadSettle | 'pending' = 'pending';
    const consuming = (async (): Promise<void> => {
      outcome = await settled;
    })();

    await vi.advanceTimersByTimeAsync(400);
    expect(outcome).toBe('pending');

    sign = 'none';
    await vi.advanceTimersByTimeAsync(60);
    await consuming;

    expect(outcome).toBe('no_sign');
  });

  it('hears the announcement that lands after the tool answered, on that same call', async () => {
    const downloads = makeDownloads();
    const { hold } = makeHold(downloads);
    let sign: DownloadSign = 'none';

    hold.tab(agentTab());

    const callStartedAt = Date.now();

    // The click dispatched at +0 and the tool answered at +110, so the settle began with the call-start grace
    // (40 ms from +0) already spent: only a grace measured from the settle can still hear this file.
    await vi.advanceTimersByTimeAsync(110);

    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: () => sign,
      since: callStartedAt,
      timeoutMs: 1500,
    });

    // The tab announces the file at +110, at the tool's own answer: inside the sign grace.
    await vi.advanceTimersByTimeAsync(0);
    sign = 'download';
    // The bound is the settle's own 1500 ms, not the call's: measured from the call start it would already be spent.
    await vi.advanceTimersByTimeAsync(1560);

    // A signed call that decided nothing inside the bound: the call answers the refusal itself, not the next one.
    await expect(settled).resolves.toBe('waiting_for_item');
    expect(hold.drain('session-1')).toStrictEqual([]);
  });

  /**
   * The defect this covers: the bound was `since + timeoutMs`, so a tool slower than the bound reached its own settle
   * with the deadline already past and answered over an item that was still in flight.
   */
  it('waits its full bound when the tool outlasted it, so a late item is still decided', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);

    hold.tab(agentTab());

    // The tool took 2500 ms — longer than the settle's 1500 — so a bound measured from the call start is long spent.
    const callStartedAt = Date.now();

    await vi.advanceTimersByTimeAsync(2500);

    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: () => 'download',
      since: callStartedAt,
      timeoutMs: 1500,
    });
    let outcome: DownloadSettle | 'pending' = 'pending';
    const consuming = (async (): Promise<void> => {
      outcome = await settled;
    })();

    // The item arrives 300 ms into the settle: it is the call's own download, and it is decided before the bound.
    await vi.advanceTimersByTimeAsync(300);
    hold.handle({ id: 1, referrer: page, url: 'https://app.example/reports/q4.pdf' }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS + 20);
    await consuming;

    expect(outcome).toBe('decided');
    expect(reports).toStrictEqual(['stopped:q4.pdf']);
  });

  /**
   * One click that starts two attachments hands the browser two items a few milliseconds apart. The first refusal
   * must not end the call: the sibling is the same gesture's file, and its report is that call's to carry. Ending on
   * the first decision leaves the sibling's refusal to be read as news from an earlier call by whichever call comes
   * next, which then answers a refusal for a file it never started.
   */
  it('keeps the call open for the sibling item of the same gesture', async () => {
    const downloads = makeDownloads();
    const { hold, reports } = makeHold(downloads);
    let sign: DownloadSign = 'none';

    hold.tab(agentTab());

    const callStartedAt = Date.now();
    const settled = hold.settle('session-1', {
      graceMs: 40,
      sign: () => sign,
      since: callStartedAt,
      timeoutMs: 2000,
    });
    let outcome: DownloadSettle | 'pending' = 'pending';
    const consuming = (async (): Promise<void> => {
      outcome = await settled;
    })();

    // The click answered with nothing yet: the browser announces one file, then creates its item.
    sign = 'download';
    await vi.advanceTimersByTimeAsync(20);
    hold.handle({ id: 1, referrer: page, url: `${page}/report.txt` }, () => {
      downloads.order.push('suggest');
    });
    await vi.advanceTimersByTimeAsync(40);

    // The first item is refused, and the call is still open: the gesture's next file may be seconds behind, and its
    // Refusal is this call's to carry.
    expect(hold.tracked(1)?.kind).toBe('blocked');
    expect(outcome).toBe('pending');

    await vi.advanceTimersByTimeAsync(10);
    hold.handle({ id: 2, referrer: page, url: `${page}/second.txt` }, () => {
      downloads.order.push('suggest');
    });

    // Both refusals are this call's: the settle ended only once the gesture was quiet.
    await vi.advanceTimersByTimeAsync(500);
    await consuming;

    expect(outcome).toBe('decided');
    expect(reports).toStrictEqual(['stopped:report.txt', 'stopped:second.txt']);
  });
});
