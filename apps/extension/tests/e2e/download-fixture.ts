/* eslint-disable import/no-nodejs-modules, promise/avoid-new -- the download fixture is a real HTTP server with a Content-Disposition route */
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
/**
 * The route that serves the attachment once and answers every later request with a redirect to the `next` url it is
 * given: a repeat of the same step loads a page instead of a file, and reports where that page settled.
 */
export const ONCE_DOWNLOAD_PATH = '/assets/once-report.txt';
/** The held route: an attachment whose response lands only when the test says so. */
export const LATE_DOWNLOAD_PATH = '/assets/late-report.txt';
/** The second attachment one click starts on the `/two` page: the file no approval covers. */
export const SECOND_DOWNLOAD_PATH = '/assets/second.txt';
export const SECOND_DOWNLOAD_FILENAME = 'second.txt';
export const SECOND_DOWNLOAD_BODY = 'second fixture download body\n';
/** The page whose one button starts both attachments; the guard has to decide each of them. */
export const TWO_DOWNLOADS_PAGE_PATH = '/two';
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
  /** How many times the attachment route served a body: a cancelled download still reaches it. */
  readonly hits: () => number;
  /** How many times the held attachment route was asked for the file. */
  readonly lateHits: () => number;
  /** How many times the attachment that answers once was asked: the repeat's request is counted here too. */
  readonly onceHits: () => number;
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
  let onceHits = 0;
  let secondHits = 0;
  let userHits = 0;
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

    if (path === ONCE_DOWNLOAD_PATH) {
      onceHits += 1;

      // The first request is the file the step asked for; every later one is a page the browser loads instead, so a
      // Repeat of the step loads a document and the answer describes that document.
      const next = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('next');

      if (onceHits > 1 && next !== null) {
        response.writeHead(302, { 'cache-control': 'no-store', location: next });
        response.end();

        return;
      }

      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${DOWNLOAD_FILENAME}"`,
        'content-type': 'application/octet-stream',
      });
      response.end(DOWNLOAD_BODY);

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
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
    hits: () => hits,
    lateHits: () => lateHits,
    onceHits: () => onceHits,
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
