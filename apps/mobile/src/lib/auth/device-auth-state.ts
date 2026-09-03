import { type NativeTokenPair } from '@kilocode/app-shared/native-auth';

type DeviceAuthStatus = 'idle' | 'pending' | 'approved' | 'denied' | 'expired' | 'error';

export type DeviceAuthState = {
  status: DeviceAuthStatus;
  code: string | undefined;
  credentials: NativeTokenPair | undefined;
  error: string | undefined;
  verificationUrl: string | undefined;
  resumed?: boolean;
};

export function errorDeviceAuthState(
  code: string | undefined,
  error: string,
  previousVerificationUrl: string | undefined
): DeviceAuthState {
  return {
    status: 'error',
    code,
    credentials: undefined,
    error,
    verificationUrl: previousVerificationUrl,
  };
}

export function idleDeviceAuthState(): DeviceAuthState {
  return {
    status: 'idle',
    code: undefined,
    credentials: undefined,
    error: undefined,
    verificationUrl: undefined,
  };
}

export function pendingDeviceAuthState(
  code: string | undefined,
  verificationUrl: string | undefined,
  resumed = false
): DeviceAuthState {
  return {
    status: 'pending',
    code,
    credentials: undefined,
    error: undefined,
    verificationUrl,
    resumed,
  };
}

export function approvedDeviceAuthState(params: {
  code: string;
  credentials: NativeTokenPair;
  previousVerificationUrl?: string;
}): DeviceAuthState {
  return {
    status: 'approved',
    code: params.code,
    credentials: params.credentials,
    error: undefined,
    verificationUrl: params.previousVerificationUrl,
  };
}

export function terminalDeviceAuthState(params: {
  status: 'denied' | 'expired';
  code: string;
  error: string;
  previousVerificationUrl?: string;
}): DeviceAuthState {
  return {
    status: params.status,
    code: params.code,
    credentials: undefined,
    error: params.error,
    verificationUrl: params.previousVerificationUrl,
  };
}
