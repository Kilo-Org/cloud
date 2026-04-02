/**
 * OpenRouter API types - locally defined to avoid external SDK dependency.
 * These types mirror the OpenRouter API specification.
 */

/**
 * Error structure returned by OpenRouter API.
 */
export type ChatErrorError = {
  code: string | number | null;
  message: string;
  param?: string | null | undefined;
  type?: string | null | undefined;
};
