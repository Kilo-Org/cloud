import { describe, it, expect } from '@jest/globals';
import { detectConfigImportOs, getConfigImportCommands } from './config-import-commands';

describe('detectConfigImportOs', () => {
  it('detects desktop operating systems', () => {
    expect(detectConfigImportOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectConfigImportOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
    expect(detectConfigImportOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('returns null for mobile devices, which cannot run the commands', () => {
    expect(detectConfigImportOs('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBeNull();
    expect(detectConfigImportOs('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBeNull();
  });
});

describe('getConfigImportCommands', () => {
  it('zips each source into its own archive in the home directory on Unix', () => {
    const [global, project] = getConfigImportCommands('macos');

    expect(global).toMatchObject({ id: 'global', displayPath: '~/.config/kilo' });
    expect(global.command).toMatch(
      /^\(cd "\$HOME\/\.config\/kilo" && zip -r -FS "\$HOME\/kilo-config\.zip" \. -x /
    );
    expect(project).toMatchObject({ id: 'project', displayPath: '.kilo' });
    expect(project.command).toMatch(
      /^\(cd \.kilo && zip -r -FS "\$HOME\/kilo-project-config\.zip" \. -x /
    );
  });

  it('uses tar.exe with root-anchored exclusions on Windows', () => {
    const [global] = getConfigImportCommands('windows');

    expect(global.command).toContain('tar.exe -a -cf "$HOME\\kilo-config.zip"');
    expect(global.command).toContain("--exclude '^package.json'");
    expect(global.command).toContain('-C "$HOME\\.config\\kilo" .');
  });
});
