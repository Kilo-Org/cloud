import { saveStoredAuth } from './auth';
import type { AuthStorageArea, StoredAuth } from './auth';

export type ApprovedDeviceAuthPersistenceResult =
  | {
      readonly auth: StoredAuth;
      readonly status: 'signedIn';
    }
  | {
      readonly message: string;
      readonly status: 'failed';
    };

export const persistApprovedDeviceAuth = async (
  storageArea: AuthStorageArea,
  auth: StoredAuth
): Promise<ApprovedDeviceAuthPersistenceResult> => {
  try {
    await saveStoredAuth(storageArea, auth);
    return { auth, status: 'signedIn' };
  } catch {
    return { message: 'Sign in failed. Try again.', status: 'failed' };
  }
};
