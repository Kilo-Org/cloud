import { EDITOR_OPTIONS } from '@/lib/editorOptions';

describe('Editor Options', () => {
  test('every editor without a download URL should be hidden', () => {
    const editorsWithoutDownloadUrl = EDITOR_OPTIONS.filter(editor => !editor.downloadUrl);

    editorsWithoutDownloadUrl.forEach(editor => {
      expect(editor.visibilityOnInstallPage).toBe('hide');
    });
  });
});
