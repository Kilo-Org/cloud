type DeviceAuthStatus = 'idle' | 'pending' | 'approved' | 'denied' | 'expired' | 'error';

export type DeviceAuthState = {
  status: DeviceAuthStatus;
  code: string | undefined;
  token: string | undefined;
  refreshToken: string | undefined;
  expiresIn: number | undefined;
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
    token: undefined,
    refreshToken: undefined,
    expiresIn: undefined,
    error,
    verificationUrl: previousVerificationUrl,
  };
}

export function idleDeviceAuthState(): DeviceAuthState {
  return {
    status: 'idle',
    code: undefined,
    token: undefined,
    refreshToken: undefined,
    expiresIn: undefined,
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
    token: undefined,
    refreshToken: undefined,
    expiresIn: undefined,
    error: undefined,
    verificationUrl,
    resumed,
  };
}

export function approvedDeviceAuthState(params: {
  code: string;
  token: string;
  refreshToken?: string;
  expiresIn?: number;
  previousVerificationUrl?: string;
}): DeviceAuthState {
  return {
    status: 'approved',
    code: params.code,
    token: params.token,
    refreshToken: params.refreshToken,
    expiresIn: params.expiresIn,
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
    token: undefined,
    refreshToken: undefined,
    expiresIn: undefined,
    error: params.error,
    verificationUrl: params.previousVerificationUrl,
  };
}
