export type SuccessResponse<T> = {
  success: true;
  data: T;
};

export type ErrorResponse = {
  success: false;
  error: string;
};

export function resSuccess<T>(data: T): SuccessResponse<T> {
  return { success: true, data };
}

export function resError(error: string): ErrorResponse {
  return { success: false, error };
}
