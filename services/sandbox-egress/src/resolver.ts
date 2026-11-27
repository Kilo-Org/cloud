import { z } from 'zod';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';
import { readAwsResponse } from '@kilocode/worker-utils/aws-client';
import { EgressTransportError, isPublicAddress } from './destination.js';
import { fetchAtAddress, type PublicResolver } from './https-transport.js';

const answerSchema = z.object({
  Status: z.literal(0),
  TC: z.literal(false),
  Question: z.array(z.object({ name: z.string(), type: z.literal(1) })).length(1),
  Answer: z.array(z.object({ type: z.number().int(), data: z.string() })).max(64),
});
const resolverAddresses = ['1.1.1.1', '1.0.0.1'] as const;

/** A fixed verified resolver avoids the sandbox VPC's intentionally restricted DNS. No global DNS mutation. */
export function createPublicResolver(query = fetchAtAddress): PublicResolver {
  return async (value, signal) => {
    const hostname = egressDomainSchema.safeParse(value).data;
    if (!hostname) throw new EgressTransportError('destination_denied');
    for (const bootstrap of resolverAddresses) {
      signal.throwIfAborted();
      let response: Response;
      try {
        const url = new URL('https://cloudflare-dns.com/dns-query');
        url.searchParams.set('name', hostname);
        url.searchParams.set('type', 'A');
        response = await query(
          new Request(url, {
            headers: { accept: 'application/dns-json' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
            redirect: 'manual',
          }),
          bootstrap
        );
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }
        const answer = answerSchema.safeParse(JSON.parse(await readAwsResponse(response, 32_768)));
        if (
          !answer.success ||
          egressDomainSchema.safeParse(answer.data.Question[0].name).data !== hostname
        )
          continue;
        const addresses = [
          ...new Set(answer.data.Answer.filter(row => row.type === 1).map(row => row.data)),
        ];
        if (!addresses.length || addresses.some(address => !isPublicAddress(address)))
          throw new EgressTransportError('destination_denied');
        return addresses;
      } catch (error) {
        if (error instanceof EgressTransportError && error.code === 'destination_denied')
          throw error;
      }
    }
    throw new EgressTransportError('dns_unavailable');
  };
}
