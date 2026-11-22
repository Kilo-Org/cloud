/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new -- the download fixture is a real HTTP server with a Content-Disposition route */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';

/*
 * A page whose interesting controls start a download. The response carries
 * `Content-Disposition: attachment`, so Chromium treats the navigation as a
 * download rather than a document, which is the exact case the agent's
 * download guard has to cancel.
 *
 * Two routes serve the same file. `/assets/report.txt` answers at once — the
 * download the call that started it can still stop inside its own window.
 * `/assets/late-report.txt` holds its headers until the test releases it, which
 * it does only after the click that started it has answered: the browser
 * creates the download after the call, so the file lands in the guard's late
 * window with no race against the click's own wait.
 *
 * The slow link asks for its file into a hidden frame rather than as the tab's
 * own navigation: Chromium holds a top-level navigation's input command open
 * until the response headers arrive, so a link that would answer only after the
 * click could never let the click answer first. The frame's request is a
 * download like any other, and the click returns as soon as it is dispatched.
 */

export const DOWNLOAD_PATH = '/assets/report.txt';
export const DOWNLOAD_FILENAME = 'report.txt';
export const DOWNLOAD_BODY = 'fixture download body\n';
/** The held route: an attachment whose response lands only when the test says so. */
export const LATE_DOWNLOAD_PATH = '/assets/late-report.txt';
/** The second attachment one click starts on the `/two` page: the file no approval covers. */
export const SECOND_DOWNLOAD_PATH = '/assets/second.txt';
export const SECOND_DOWNLOAD_FILENAME = 'second.txt';
export const SECOND_DOWNLOAD_BODY = 'second fixture download body\n';
/** The page whose one button starts both attachments; the guard has to decide each of them. */
export const TWO_DOWNLOADS_PAGE_PATH = '/two';
/**
 * The page whose payment-form submit starts an attachment: the click is a sensitive step of its own, and the file the
 * same gesture starts is a second one the step's approval does not buy.
 */
export const CARD_PAGE_PATH = '/card';
/**
 * An attachment-shaped control whose response is an error: the guard still has to decide the click, but the browser
 * gets a plain error body instead of a file, so there is never an item to keep.
 */
export const BROKEN_DOWNLOAD_PATH = '/assets/broken-report.txt';
/** The page whose drop zone reports the names of the files a drop handed it. */
export const DROP_PAGE_PATH = '/drop';
/** Where the drop page reports those names: the fixture answers 204 and records the list. */
export const DROP_RECEIVED_PATH = '/drop-received';
/** A page with no agent attached to it: a download started here is the user's own. */
export const USER_PAGE_PATH = '/user';
/** The user's own file, named apart from the agent's so a folder read says whose it is. */
export const USER_DOWNLOAD_PATH = '/assets/user.txt';
export const USER_DOWNLOAD_FILENAME = 'user.txt';
export const USER_DOWNLOAD_BODY = 'user download body\n';

const DOWNLOAD_PAGE_HTML = `<!doctype html>
<html>
  <head><title>Download page</title></head>
  <body>
    <h1>Download page</h1>
    <p>A link that hands the browser a file instead of a document.</p>
    <a href="${DOWNLOAD_PATH}">Download report</a>
    <a href="${BROKEN_DOWNLOAD_PATH}" download>Broken report</a>
    <a id="slow-download" href="#slow">Download slow report</a>
    <button type="button">Plain button</button>
    <iframe name="slow-sink" hidden></iframe>
    <script>
      // Every click needs its own navigation: assigning the same value an iframe's src already has changes nothing.
      let slowClicks = 0;
      document.querySelector('#slow-download').addEventListener('click', event => {
        event.preventDefault();
        slowClicks += 1;
        document.querySelector('iframe[name="slow-sink"]').src = '${LATE_DOWNLOAD_PATH}?click=' + slowClicks;
      });
    </script>
  </body>
</html>`;

/*
 * One button, two attachments, no user gesture per file. Both requests are
 * started by the same click: the guarded call starts two downloads and may keep
 * neither, and an approved repeat keeps exactly its own step's file.
 *
 * Each link is clicked through a hidden iframe rather than as the tab's own
 * navigation, so the click that starts them answers at once and the two items
 * arrive together, which is the case the guard has to decide per item.
 */
const TWO_DOWNLOADS_PAGE_HTML = `<!doctype html>
<html>
  <head><title>Two downloads page</title></head>
  <body>
    <h1>Two downloads page</h1>
    <p>One button that hands the browser two files.</p>
    <button id="two-downloads" type="button">Download both reports</button>
    <iframe name="first-sink" hidden></iframe>
    <iframe name="second-sink" hidden></iframe>
    <script>
      // Each frame gets its own URL per click: assigning the value its src already has changes nothing.
      let clicks = 0;
      document.querySelector('#two-downloads').addEventListener('click', () => {
        clicks += 1;
        document.querySelector('iframe[name="first-sink"]').src = '${DOWNLOAD_PATH}?click=' + clicks;
        document.querySelector('iframe[name="second-sink"]').src = '${SECOND_DOWNLOAD_PATH}?click=' + clicks;
      });
    </script>
  </body>
</html>`;

/*
 * A payment form whose submit starts an attachment. The click is a sensitive
 * step — a submit control inside a form holding a card field — and it is also
 * the gesture that starts the download.
 *
 * The submit's handler cancels the navigation and points a hidden frame at the
 * file instead: the click answers at once, and the download the same gesture
 * starts is created before the call that dispatched it returns.
 */
const CARD_PAGE_HTML = `<!doctype html>
<html>
  <head><title>Payment page</title></head>
  <body>
    <h1>Payment page</h1>
    <form id="pay">
      <label for="cc">Card number</label>
      <input id="cc" name="cc-number" autocomplete="cc-number" value="4242424242424242">
      <button id="receipt" type="submit">Get receipt</button>
    </form>
    <iframe name="receipt-sink" hidden></iframe>
    <script>
      // Every submit needs its own url: assigning the value the frame's src already has changes nothing.
      let receipts = 0;
      document.querySelector('#pay').addEventListener('submit', event => {
        event.preventDefault();
        receipts += 1;
        document.querySelector('iframe[name="receipt-sink"]').src = '${DOWNLOAD_PATH}?receipt=' + receipts;
      });
    </script>
  </body>
</html>`;

/*
 * A drop zone that names what it received to the fixture. The page never keeps
 * a file: the report is the name list the browser's own `dataTransfer` held,
 * which is how a spec proves the page got the file at all.
 */
const DROP_PAGE_HTML = `<!doctype html>
<html>
  <head><title>Drop page</title></head>
  <body>
    <h1>Drop page</h1>
    <div id="zone" role="region" aria-label="Drop zone" tabindex="0">Drop files here</div>
    <script>
      const zone = document.querySelector('#zone');
      zone.addEventListener('dragover', event => {
        event.preventDefault();
      });
      zone.addEventListener('drop', event => {
        event.preventDefault();
        const names = Array.from(event.dataTransfer?.files ?? []).map(file => file.name);
        void fetch('${DROP_RECEIVED_PATH}?names=' + encodeURIComponent(names.join(',')));
      });
    </script>
  </body>
</html>`;

/** A page with no agent attached: a download here is the user's own and passes through untouched. */
const USER_PAGE_HTML = `<!doctype html>
<html>
  <head><title>User download page</title></head>
  <body>
    <h1>User download page</h1>
    <a href="${USER_DOWNLOAD_PATH}">Download the user report</a>
  </body>
</html>`;

export interface DownloadFixture {
  readonly close: () => Promise<void>;
  /** How many times the attachment route answered an error: a click the guard still decided reached the fixture. */
  readonly brokenHits: () => number;
  /** The name lists the drop page reported, one entry per drop that reached it: the page's own record of the files. */
  readonly dropReceived: () => readonly (readonly string[])[];
  /** How many times the attachment route served a body: a cancelled download still reaches it. */
  readonly hits: () => number;
  /** How many times the held attachment route was asked for the file. */
  readonly lateHits: () => number;
  /** Answers every held request: the browser creates the download only now, long after the click answered. */
  readonly releaseLate: () => void;
  /** How many times the second attachment of a `/two` click was served. */
  readonly secondHits: () => number;
  /** How many times the user's own attachment was served. */
  readonly userHits: () => number;
  readonly url: string;
  /** Resolves once the held route has been asked for its file `count` times: the request is in flight and waiting. */
  readonly waitForLate: (count: number) => Promise<void>;
}

export const startDownloadFixture = async (): Promise<DownloadFixture> => {
  let hits = 0;
  let lateHits = 0;
  let secondHits = 0;
  let userHits = 0;
  let brokenHits = 0;
  /** One entry per drop the page reported, in arrival order: the file names its own `dataTransfer` carried. */
  const dropsReceived: (readonly string[])[] = [];
  /** The routes waiting for the test: answering one makes the browser create its download. */
  const held: (() => void)[] = [];
  /** Calls waiting until the held route has been asked `count` times: the file is requested but not yet answered. */
  const lateWaiters: { readonly count: number; readonly resolve: () => void }[] = [];
  /** Notes one request for a held file and wakes the waiters it satisfies. */
  const noteLateRequest = (): void => {
    lateHits += 1;

    // Backwards: a satisfied waiter leaves the list, and the ones before it keep their index.
    for (let index = lateWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = lateWaiters[index];

      if (waiter !== undefined && lateHits >= waiter.count) {
        lateWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    if (path === DROP_RECEIVED_PATH) {
      // The page's report of what it received: a drop that never reached it reports nothing, which is the assertion.
      const names = new URL(request.url ?? '/', 'http://fixture').searchParams.get('names') ?? '';
      const reported = names === '' ? [] : names.split(',');

      dropsReceived.push(reported);
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();

      return;
    }

    if (path === BROKEN_DOWNLOAD_PATH) {
      brokenHits += 1;
      // No `content-disposition`: the browser gets an error page, not a file it could ever write to the folder.
      response.writeHead(500, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('fixture attachment failure\n');

      return;
    }

    if (path === USER_DOWNLOAD_PATH) {
      userHits += 1;
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${USER_DOWNLOAD_FILENAME}"`,
        'content-type': 'application/octet-stream',
      });
      response.end(USER_DOWNLOAD_BODY);

      return;
    }

    if (path === SECOND_DOWNLOAD_PATH) {
      secondHits += 1;
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${SECOND_DOWNLOAD_FILENAME}"`,
        'content-type': 'application/octet-stream',
      });
      response.end(SECOND_DOWNLOAD_BODY);

      return;
    }

    if (path === DOWNLOAD_PATH || path === LATE_DOWNLOAD_PATH) {
      const answer = (): void => {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${DOWNLOAD_FILENAME}"`,
          'content-type': 'application/octet-stream',
        });
        response.end(DOWNLOAD_BODY);
      };

      if (path === LATE_DOWNLOAD_PATH) {
        noteLateRequest();
        // No delay at all: the response is held until the test releases it, so "after the click" is a fact.
        held.push(answer);
      } else {
        hits += 1;
        answer();
      }

      return;
    }

    if (path === '/page' || path === '/') {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(DOWNLOAD_PAGE_HTML);

      return;
    }

    if (path === TWO_DOWNLOADS_PAGE_PATH) {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(TWO_DOWNLOADS_PAGE_HTML);

      return;
    }

    if (path === CARD_PAGE_PATH) {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(CARD_PAGE_HTML);

      return;
    }

    if (path === DROP_PAGE_PATH) {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(DROP_PAGE_HTML);

      return;
    }

    if (path === USER_PAGE_PATH) {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(USER_PAGE_HTML);

      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    brokenHits: () => brokenHits,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
    dropReceived: () => dropsReceived,
    hits: () => hits,
    lateHits: () => lateHits,
    releaseLate: () => {
      for (const answer of held.splice(0)) {
        answer();
      }
    },
    secondHits: () => secondHits,
    url: `http://127.0.0.1:${String(port)}`,
    userHits: () => userHits,
    waitForLate: count => {
      if (lateHits >= count) {
        return Promise.resolve();
      }

      const { promise, resolve } = Promise.withResolvers<void>();

      lateWaiters.push({ count, resolve });

      return promise;
    },
  };
};
