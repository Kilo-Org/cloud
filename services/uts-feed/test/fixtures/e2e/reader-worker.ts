import {
  encodeBase64Url,
  feedReaderSources,
  type FeedReaderBinding,
} from '@kilocode/uts-contracts';

/**
 * A Worker verifier for the local end-to-end run (scripts/feed-e2e.ts in services/uts): it reads
 * the revocation feed through the feed Worker's `FeedReader` entrypoint over a service binding,
 * with the transport the verification library takes (`feedReaderSources`), and answers what it
 * read over HTTP so the run can verify it.
 */
type Env = { UTS_FEED: FeedReaderBinding };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sources = feedReaderSources(env.UTS_FEED);
    const { pathname } = new URL(request.url);
    const signal = AbortSignal.timeout(5000);
    try {
      if (pathname === '/head') return new Response(await sources.feed.head(signal));
      if (pathname.startsWith('/list/')) {
        return new Response(await sources.feed.list(pathname.slice('/list/'.length), signal));
      }
      if (pathname === '/bootstrap') {
        const answer = await sources.bootstrap(signal);
        return Response.json({ ...answer, list: encodeBase64Url(answer.list) });
      }
      return new Response('not found', { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
