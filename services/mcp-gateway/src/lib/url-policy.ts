import {
  createGatewayError,
  GatewayErrorCode,
  isIpAddress,
  isPublicIp,
} from '@kilocode/mcp-gateway';
import { z } from 'zod';

const dnsResponseSchema = z
  .object({
    Answer: z.array(z.object({ data: z.string() })).optional(),
  })
  .passthrough();

export function validatePublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid upstream URL', 400);
  }
  if (url.protocol !== 'https:') {
    throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Upstream must use HTTPS', 400);
  }
  if (url.username || url.password || url.hash) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Upstream must not contain credentials or fragment',
      400
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Upstream must be publicly reachable',
      400
    );
  }
  if (isIpAddress(hostname) && !isPublicIp(hostname)) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Upstream must be publicly reachable',
      400
    );
  }
  return url;
}

async function queryDnsAnswers(hostname: string, type: 'A' | 'AAAA', fetchImpl: typeof fetch) {
  const dohUrl = new URL('https://cloudflare-dns.com/dns-query');
  dohUrl.searchParams.set('name', hostname);
  dohUrl.searchParams.set('type', type);
  const response = await fetchImpl(dohUrl.toString(), {
    headers: { Accept: 'application/dns-json' },
    redirect: 'manual',
  });
  if (!response.ok) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Upstream DNS could not be validated',
      400
    );
  }
  const parsed = dnsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Upstream DNS could not be validated',
      400
    );
  }
  return parsed.data.Answer?.map(answer => answer.data).filter(isIpAddress) ?? [];
}

export async function validateResolvedPublicUrl(
  value: string,
  fetchImpl: typeof fetch
): Promise<URL> {
  const target = validatePublicHttpsUrl(value);
  const hostname = target.hostname.toLowerCase();
  if (isIpAddress(hostname)) return target;
  const [ipv4, ipv6] = await Promise.all([
    queryDnsAnswers(hostname, 'A', fetchImpl),
    queryDnsAnswers(hostname, 'AAAA', fetchImpl),
  ]);
  const addresses = [...ipv4, ...ipv6];
  if (addresses.length === 0) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Upstream DNS could not be validated',
      400
    );
  }
  if (addresses.some(address => !isPublicIp(address))) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Upstream resolves to a private destination',
      400
    );
  }
  return target;
}

export async function validateRedirectTarget(
  location: string,
  fetchImpl: typeof fetch
): Promise<URL> {
  return await validateResolvedPublicUrl(location, fetchImpl);
}
