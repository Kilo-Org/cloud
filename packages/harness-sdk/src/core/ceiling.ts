import { Context } from 'effect';
import type { Effort } from './model.js';

/**
 * Decides the most tokens one answer may use, when the caller names no number.
 *
 * This is a plugin because the right ceiling belongs to the application, not to
 * the package. A phone wants short answers. A coding harness wants long ones. A
 * model-aware plugin can read the model's own output limit. The package ships a
 * fixed plugin and no opinion beyond it.
 */
interface TokenCeilingService {
  readonly of: (request: { readonly model: string; readonly effort?: Effort }) => number;
}

class TokenCeiling extends Context.Tag('harness/TokenCeiling')<
  TokenCeiling,
  TokenCeilingService
>() {}

export type { TokenCeilingService };
export { TokenCeiling };
