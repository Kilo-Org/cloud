// Type declarations for cloudflare:test module
// This enables type-safe access to env bindings in integration tests

import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  // ProvidedEnv extends your worker's Env interface
  // This gives you typed access to bindings like env.CLOUD_AGENT_SESSION
  interface ProvidedEnv extends Env {}
}
