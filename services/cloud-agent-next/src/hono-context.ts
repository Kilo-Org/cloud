import type { Env, ValidatedSessionAccess } from './types.js';

export type HonoContext = {
  Bindings: Env;
  Variables: {
    userId?: string;
    authToken?: string;
    botId?: string;
    validatedSessionAccess?: ValidatedSessionAccess;
  };
};
