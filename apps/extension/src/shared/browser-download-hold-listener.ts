/**
 * The one permanent `chrome.downloads.onDeterminingFilename` listener, and the
 * optional-permission edge that makes it exist.
 *
 * Chrome dispatches this event from a router that exists only when an
 * `onDeterminingFilename` listener was registered at the moment the download
 * was created, and the download does not complete until every listener has
 * called `suggest` exactly once. The `downloads` permission is optional — a
 * required one would disable the extension for every existing user — so before
 * it is granted the event does not exist for this extension at all. The
 * listener is therefore installed synchronously when the worker starts, and
 * again when the permission is granted; one install, in one place.
 */
import type { DownloadHoldItem } from './browser-download-hold';

/** The event as Chrome declares it, narrowed to what this extension uses. */
interface DeterminingFilenameEvent {
  readonly addListener: (
    listener: (
      item: DownloadHoldItem,
      suggest: (override?: { readonly filename?: string }) => void
    ) => boolean | undefined
  ) => void;
}

export interface DeterminingFilenameDownloadsApi {
  readonly onDeterminingFilename?: DeterminingFilenameEvent | undefined;
}

/** The `chrome.permissions` slice the install edge needs. */
export interface DownloadHoldPermissionsApi {
  readonly onAdded?: {
    readonly addListener: (listener: (added: { readonly permissions?: string[] }) => void) => void;
  };
}

/**
 * Whether this worker has already registered. Chrome allows one listener per
 * extension per event, and a second registration would either throw or make the
 * listener fire twice for one download.
 */
let registered = false;

/** Registers the listener, once, and answers whether this browser has the event at all. */
export const installDownloadHoldListener = ({
  downloads,
  handle,
}: {
  /** `chrome.downloads`, read now: the optional permission may have been granted since the last attempt. */
  readonly downloads: DeterminingFilenameDownloadsApi | undefined;
  /** The decision for one download: returns whether the answer is deferred. */
  readonly handle: (
    item: DownloadHoldItem,
    suggest: (override?: { readonly filename?: string }) => void
  ) => boolean;
}): boolean => {
  const event = downloads?.onDeterminingFilename;

  if (event?.addListener === undefined || registered) {
    // Firefox has no event that holds a download: its guard settles a file after it starts.
    return false;
  }

  try {
    event.addListener((item, suggest) => handle(item, suggest));
  } catch {
    // A registration that threw installed nothing: the flag stays clear, so the grant edge can try again rather than
    // Leaving the profile unguarded for the rest of the worker's life.
    return false;
  }

  registered = true;

  return true;
};

/**
 * Installs the listener now, again the moment `downloads` is granted, and once more whenever the caller asks: the
 * grant is what makes the event exist, and a browser that refuses the registration has no other edge to lean on —
 * a throw needs the event, the event needs the grant, and Chrome never repeats it. The call about to start a
 * download is then the last place a guard can land before the file, so this returns the retry for it to run.
 */
export const installDownloadHoldOnGrant = ({
  downloads,
  handle,
  permissions,
}: {
  readonly downloads: () => DeterminingFilenameDownloadsApi | undefined;
  readonly handle: (
    item: DownloadHoldItem,
    suggest: (override?: { readonly filename?: string }) => void
  ) => boolean;
  readonly permissions: DownloadHoldPermissionsApi | undefined;
}): (() => void) => {
  // One attempt, and the one a caller may repeat: `registered` makes every later pass a no-op once it has landed.
  const retry = (): void => {
    installDownloadHoldListener({ downloads: downloads(), handle });
  };

  retry();

  // A browser without `permissions.onAdded` never changes the grant while it runs, so the attempt
  // Above is final there; one that does have it can still refuse the registration, and a hold that
  // Cannot listen for the grant is still the one the current grant gave it.
  try {
    permissions?.onAdded?.addListener(added => {
      // One event, one install: a grant of anything else leaves the listener exactly where it is.
      if (added.permissions?.includes('downloads') === true) {
        retry();
      }
    });
  } catch {
    // The listener is installed already; nothing else can reach this extension's grant.
  }

  return retry;
};
