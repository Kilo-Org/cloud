import type { UtsConfig } from '../env';
import type { SignInAccess } from './store';

/** What the sign-in pages and their JSON calls need. */
export type SignInDeps = {
  config: UtsConfig;
  signIn: SignInAccess;
};
