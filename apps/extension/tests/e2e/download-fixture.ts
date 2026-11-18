/* eslint-disable import/no-nodejs-modules, promise/avoid-new -- the download fixture is a real HTTP server with a Content-Disposition route */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';

/*
 * A page whose only interesting control is a link that starts a download. The
 * response carries `Content-Disposition: attachment`, so Chromium treats the
 * navigation as a download rather than a document, which is the exact case the
 * agent's download guard has to cancel.
 */

export const DOWNLOAD_PATH = '/assets/report.txt';
export const DOWNLOAD_FILENAME = 'report.txt';
export const DOWNLOAD_BODY = 'fixture download body\n';

const DOWNLOAD_PAGE_HTML = `<!doctype html>
<html>
  <head><title>Download page</title></head>
  <body>
    <h1>Download page</h1>
    <p>A link that hands the browser a file instead of a document.</p>
    <a href="${DOWNLOAD_PATH}">Download report</a>
  </body>
</html>`;

export interface DownloadFixture {
  readonly close: () => Promise<void>;
  /** How many times the attachment route served a body: a cancelled download still reaches it. */
  readonly hits: () => number;
  readonly url: string;
}

export const startDownloadFixture = async (): Promise<DownloadFixture> => {
  let hits = 0;
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    if (path === DOWNLOAD_PATH) {
      hits += 1;
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${DOWNLOAD_FILENAME}"`,
        'content-type': 'application/octet-stream',
      });
      response.end(DOWNLOAD_BODY);

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
    url: `http://127.0.0.1:${String(port)}`,
  };
};
