import type { Env, ValidatedSessionAccess } from './types.js';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';

export type HonoContext = {
  Bindings: Env;
  Variables: {
    cloudAgentAuthority?: CloudAgentAuthority;
    userId?: string;
    authToken?: string;
    botId?: string;
    validatedSessionAccess?: ValidatedSessionAccess;
  };
};
