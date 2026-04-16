import * as z from 'zod';

export const proxyErrorTypeSchema = z.enum([
  'invalid_path',
  'invalid_request',
  'temporarily_unavailable',
  'upgrade_required',
  'usage_limit_exceeded',
  'data_collection_required',
  'api_kind_not_supported',
  'stealth_model_error',
  'byok_error',
  'context_length_exceeded',
  'model_not_allowed',
  'discontinued_free_model',
  'model_not_found',
  'feature_exclusive_model',
  'unsupported_field',
  'authentication_required',
  'missing_client_ip',
  'rate_limit_exceeded',
  'paid_model_auth_required',
  'promotion_limit_reached',
  'unsupported_fim_model',
  'insufficient_credits',
  'provider_not_allowed',
  'byok_key_required',
  'upstream_error',
]);

export type ProxyErrorType = z.infer<typeof proxyErrorTypeSchema>;

export const ProxyErrorType = proxyErrorTypeSchema.enum;
