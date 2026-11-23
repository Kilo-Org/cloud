/**
 * The environment setup role a session serves. Set only by preflight: a client
 * can never bind a session to a setup run, and the wrapper reads it as
 * DO-private metadata.
 */
export type EnvironmentSetupBinding = {
  runId: string;
  environmentId: string;
  role: 'setup' | 'verification';
};
