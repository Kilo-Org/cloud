import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import type { MobileRouter } from '@kilocode/trpc/mobile';

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * Creates a tRPC client scoped to the MobileRouter type, wired with
 * {@link https://trpc.io/docs/client/links/splitLink splitLink} so
 * callers can opt into unbatchable requests via `op.context.skipBatch`.
 *
 * Use this instead of a hand-rolled fetch client for server-proxied
 * tRPC calls. Import `MobileRouter` **only as a type** — the import
 * is erased at build time and server-only code never enters the bundle.
 */
export const createExtensionTrpcClient = ({
  apiBaseUrl,
  getToken,
}: {
  readonly apiBaseUrl: string;
  readonly getToken: () => string | undefined;
}): ReturnType<typeof createTRPCClient<MobileRouter>> => {
  const trpcUrl = `${trimTrailingSlash(apiBaseUrl)}/api/trpc`;

  const headers = (): Record<string, string> => {
    const token = getToken();
    return token === undefined || token === '' ? {} : { Authorization: `Bearer ${token}` };
  };

  return createTRPCClient<MobileRouter>({
    links: [
      splitLink({
        condition: op => op.context['skipBatch'] === true,
        false: httpBatchLink({ headers, url: trpcUrl }),
        true: httpLink({ headers, url: trpcUrl }),
      }),
    ],
  });
};
