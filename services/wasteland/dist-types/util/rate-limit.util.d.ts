type RateLimitConfig = {
    /** Maximum number of requests allowed within the window. */
    maxRequests: number;
    /** Time window in milliseconds. */
    windowMs: number;
};
/** Per-operation rate limit configs. */
export declare const RATE_LIMITS: Record<string, RateLimitConfig>;
/**
 * Check whether the request should be allowed under the rate limit.
 * Throws a TRPCError with code TOO_MANY_REQUESTS if the limit is exceeded.
 *
 * If no rate limit is configured for the given operation, the request is
 * always allowed.
 */
export declare function checkRateLimit(userId: string, operation: string): void;
export {};
