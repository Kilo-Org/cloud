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
 */

export const DOWNLOAD_PATH = '/assets/report.txt';
export const DOWNLOAD_FILENAME = 'report.txt';
export const DOWNLOAD_BODY = 'fixture download body\n';
/** The held route: an attachment whose response lands only when the test says so. */
export const LATE_DOWNLOAD_PATH = '/assets/late-report.txt';

const DOWNLOAD_PAGE_HTML = `<!doctype html>
<html>
  <head><title>Download page</title></head>
  <body>
    <h1>Download page</h1>
    <p>A link that hands the browser a file instead of a document.</p>
    <a href="${DOWNLOAD_PATH}">Download report</a>
    <a href="${LATE_DOWNLOAD_PATH}">Download slow report</a>
    <button type="button">Plain button</button>
  </body>
</html>`;

export interface DownloadFixture {
  readonly close: () => Promise<void>;
  /** How many times the attachment route served a body: a cancelled download still reaches it. */
  readonly hits: () => number;
  /** How many times the held attachment route was asked for the file. */
  readonly lateHits: () => number;
  /** Answers every held request: the browser creates the download only now, long after the click answered. */
  readonly releaseLate: () => void;
  readonly url: string;
}

export const startDownloadFixture = async (): Promise<DownloadFixture> => {
  let hits = 0;
  let lateHits = 0;
  /** The routes waiting for the test: answering one makes the browser create its download. */
  const held: (() => void)[] = [];
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

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
        lateHits += 1;
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
    releaseLate: () => {
      for (const answer of held.splice(0)) {
        answer();
      }
    },
    url: `http://127.0.0.1:${String(port)}`,
  };
};
