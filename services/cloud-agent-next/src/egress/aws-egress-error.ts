/** Fixed public refusals; provider responses and credential data never enter the reply. */
export class AwsEgressAdmissionError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: string
  ) {
    super(code);
    this.name = 'AwsEgressAdmissionError';
  }
}
export function awsEgressFailure(error: unknown): { status: 401 | 403 | 503; code: string } {
  return error instanceof AwsEgressAdmissionError
    ? { status: error.status, code: error.code }
    : { status: 503, code: 'egress_unavailable' };
}
export function awsEgressFailureResponse(error: unknown): Response {
  const { status, code } = awsEgressFailure(error);
  return Response.json({ code }, { status });
}
