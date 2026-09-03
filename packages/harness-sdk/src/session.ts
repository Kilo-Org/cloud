/**
 * A session is one conversation between a user and an agent. Everything else
 * plugs into it. This construct holds the identity and nothing more.
 */
interface Session {
  readonly id: string;
}

const make = (id: string): Session => ({ id });

export type { Session };
export { make };
