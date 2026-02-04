import type { Env } from './types.js';

export type HonoContext = {
  Bindings: Env;
  Variables: {
    userId?: string;
    authToken?: string;
    botId?: string;
  };
};
