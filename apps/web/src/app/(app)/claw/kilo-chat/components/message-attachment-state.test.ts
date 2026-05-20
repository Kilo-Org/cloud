import { getImageAttachmentRenderState } from './MessageAttachment';

describe('getImageAttachmentRenderState', () => {
  it('shows image URL fetch errors before falling back to loading/no-data state', () => {
    expect(
      getImageAttachmentRenderState({
        hasData: false,
        isError: true,
        isLoading: false,
      })
    ).toBe('error');
  });
});
