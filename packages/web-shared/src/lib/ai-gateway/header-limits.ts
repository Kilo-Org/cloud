import { isIpAddress, isPublicIp } from './providers/ip-address';

/**
 * The one maximum for a request header value that the gateway keeps.
 *
 * `http_user_agent` and the other header-derived usage metadata columns feed
 * global lookup tables, so every value they hold is kept to this length.
 */
export const GATEWAY_HEADER_VALUE_MAX_LENGTH = 500;

/**
 * The single value stored in place of an over-long header-derived metadata value.
 * Every value over the maximum is stored as this one value.
 */
export const OVERSIZED_METADATA_VALUE = '<oversized>';

/** Slice a header value to the shared maximum, then trim; empty becomes null. */
export function limitHeaderValue(value: string | null): string | null {
  return value?.slice(0, GATEWAY_HEADER_VALUE_MAX_LENGTH).trim() || null;
}

/**
 * A header-derived usage metadata value, bounded before it reaches a lookup table.
 * A value over the maximum is stored as {@link OVERSIZED_METADATA_VALUE}.
 */
export function boundedMetadataValue(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > GATEWAY_HEADER_VALUE_MAX_LENGTH ? OVERSIZED_METADATA_VALUE : trimmed;
}

/**
 * The single client address recorded for a request, from the platform-provided
 * forward chain. Only the first hop can be the caller; the later hops are proxies.
 * The value is reduced to a bare literal: IPv6 brackets and a port are dropped. A
 * value that is not a public IP literal records no address.
 */
export function clientIpLiteral(forwardedFor: string | null): string | null {
  const firstHop = forwardedFor?.split(',')[0]?.trim();
  if (!firstHop) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(firstHop);
  const ipv4WithPort = /^([^:]+):\d+$/.exec(firstHop);
  const candidate = bracketed?.[1] ?? ipv4WithPort?.[1] ?? firstHop;
  if (candidate.includes('%')) return null;
  return isIpAddress(candidate) && isPublicIp(candidate) ? candidate : null;
}
