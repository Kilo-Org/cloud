import {
  ERROR_FINISH_REASONS,
  NON_ERROR_FINISH_REASONS,
  isErrorFinishReason,
} from '@/lib/ai-gateway/finishReason';

describe('finishReason', () => {
  it('classifies known error finish_reasons as errors', () => {
    for (const reason of ERROR_FINISH_REASONS) {
      expect(isErrorFinishReason(reason)).toBe(true);
    }
  });

  it('classifies known non-error finish_reasons as non-errors', () => {
    for (const reason of NON_ERROR_FINISH_REASONS) {
      expect(isErrorFinishReason(reason)).toBe(false);
    }
  });

  it('treats null/undefined as non-error', () => {
    expect(isErrorFinishReason(null)).toBe(false);
    expect(isErrorFinishReason(undefined)).toBe(false);
  });

  it('treats unrecognised string values as non-error', () => {
    // Unknown values should not flip hasError; other signals (statusCode,
    // wasAborted) handle those cases. This also keeps us from creating
    // spurious error rows when a new provider adds a new stop reason.
    expect(isErrorFinishReason('something_new_from_provider')).toBe(false);
  });

  it('does not double-count any reason in both lists', () => {
    const intersection = NON_ERROR_FINISH_REASONS.filter(r =>
      (ERROR_FINISH_REASONS as readonly string[]).includes(r)
    );
    expect(intersection).toEqual([]);
  });
});
