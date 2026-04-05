import { EDITOR_OPTIONS } from '@/lib/editorOptions';

describe('Editor Options', () => {
  test('every editor without a download URL should be hidden', () => {
    const editorsWithoutDownloadUrl = EDITOR_OPTIONS.filter(editor => !editor.downloadUrl);

    editorsWithoutDownloadUrl.forEach(editor => {
      expect(editor.visibilityOnInstallPage).toBe('hide');
    });
  });

  test('all editors should have required properties', () => {
    EDITOR_OPTIONS.forEach(editor => {
      expect(editor.name).toBeDefined();
      expect(editor.label).toBeDefined();
      expect(editor.extensionUrl).toBeDefined();
      expect(editor.logoSrc).toBeDefined();
      expect(editor.alt).toBeDefined();
      expect(editor.visibilityOnInstallPage).toBeDefined();
      expect(['show', 'hide', 'show-when-expanded']).toContain(editor.visibilityOnInstallPage);
    });
  });
});
