import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { Env } from '../types.js';
import type { AgentSandbox } from './protocol.js';
import { CloudflareAgentSandbox } from './cloudflare/cloudflare-agent-sandbox.js';

export function createAgentSandbox(env: Env, metadata: SessionMetadata): AgentSandbox {
  return new CloudflareAgentSandbox(env, metadata);
}
