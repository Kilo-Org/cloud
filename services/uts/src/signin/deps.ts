import type { UtsConfig } from '../env';
import type { SignInMethods } from './flows';
import type { SignInAccess } from './store';

/** What the sign-in pages and their JSON calls need. */
export type SignInDeps = {
  config: UtsConfig;
  signIn: SignInAccess;
  /** The provider, SSO and email sign-in the sign-in page offers beside the passkey. */
  methods: SignInMethods;
};
