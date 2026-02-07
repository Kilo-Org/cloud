export type Env = Omit<Cloudflare.Env, 'O11Y'> & { O11Y: O11YBinding };
