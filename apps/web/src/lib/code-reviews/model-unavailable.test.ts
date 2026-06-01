import { isCodeReviewModelUnavailableFailure } from './model-unavailable';

describe('isCodeReviewModelUnavailableFailure', () => {
  it('classifies explicit model-not-found terminal reasons', () => {
    expect(isCodeReviewModelUnavailableFailure('model_not_found')).toBe(true);
  });

  it('classifies runtime model-not-found messages case-insensitively', () => {
    expect(
      isCodeReviewModelUnavailableFailure(undefined, 'MODEL NOT FOUND: kilo/retired-model')
    ).toBe(true);
  });

  it('classifies direct and wrapped preflight unavailable-model messages', () => {
    expect(
      isCodeReviewModelUnavailableFailure(
        undefined,
        'Selected model is not available for this cloud agent session'
      )
    ).toBe(true);
    expect(
      isCodeReviewModelUnavailableFailure(
        undefined,
        'prepareSession failed (400): {"error":{"message":"Selected model is not available for this cloud agent session","code":-32600,"data":{"code":"BAD_REQUEST","httpStatus":400,"path":"prepareSession"}}}'
      )
    ).toBe(true);
  });

  it('does not classify team-policy, generic not-found, or reason-only unavailable-model failures', () => {
    expect(
      isCodeReviewModelUnavailableFailure(
        undefined,
        'Not Found: The requested model is not allowed for your team.'
      )
    ).toBe(false);
    expect(isCodeReviewModelUnavailableFailure(undefined, 'Repository not found')).toBe(false);
    expect(isCodeReviewModelUnavailableFailure('selected_model_unavailable')).toBe(false);
  });
});
