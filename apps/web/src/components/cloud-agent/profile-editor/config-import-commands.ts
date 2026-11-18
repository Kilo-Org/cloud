const EXCLUDED_DIRECTORIES = ['node_modules', '.git', '__MACOSX'];
const EXCLUDED_METADATA = ['.DS_Store', '._*', 'Thumbs.db', 'desktop.ini'];
const EXCLUDED_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'tui.json',
  'tui.jsonc',
  '.argus-kilo-integration.lock',
  '.bash-permission-migrated',
];

export type ConfigImportOs = 'windows' | 'macos' | 'linux';

export function detectConfigImportOs(userAgent: string): ConfigImportOs | null {
  if (/android|iphone|ipad|ipod/i.test(userAgent)) return null;
  if (/windows/i.test(userAgent)) return 'windows';
  if (/macintosh|mac os/i.test(userAgent)) return 'macos';
  if (/linux/i.test(userAgent)) return 'linux';
  return null;
}

const zipExclusions = [
  ...EXCLUDED_DIRECTORIES.flatMap(name => [`${name}/*`, `*/${name}/*`]),
  ...EXCLUDED_METADATA.flatMap(name => [name, `*/${name}`]),
  ...EXCLUDED_ROOT_FILES,
]
  .map(pattern => `'${pattern}'`)
  .join(' ');

const tarExclusions = [
  ...EXCLUDED_DIRECTORIES,
  ...EXCLUDED_METADATA,
  // bsdtar's ^ anchor preserves files with the same name inside skill bundles.
  ...EXCLUDED_ROOT_FILES.map(name => `^${name}`),
]
  .map(pattern => `--exclude '${pattern}'`)
  .join(' ');

export type ConfigImportSource = 'global' | 'project';

export const CONFIG_IMPORT_SOURCES: Array<{
  id: ConfigImportSource;
  label: string;
  displayPath: string;
  unixPath: string;
  windowsPath: string;
  archive: string;
}> = [
  {
    id: 'global',
    label: 'Global',
    displayPath: '~/.config/kilo',
    unixPath: '"$HOME/.config/kilo"',
    windowsPath: '"$HOME\\.config\\kilo"',
    archive: 'kilo-config.zip',
  },
  {
    id: 'project',
    label: 'Project',
    displayPath: '.kilo',
    unixPath: '.kilo',
    windowsPath: '".kilo"',
    archive: 'kilo-project-config.zip',
  },
];

export function getConfigImportCommands(os: ConfigImportOs) {
  return CONFIG_IMPORT_SOURCES.map(
    ({ id, label, displayPath, unixPath, windowsPath, archive }) => ({
      id,
      label,
      displayPath,
      archive,
      command:
        os === 'windows'
          ? `if (Test-Path -LiteralPath ${windowsPath} -PathType Container) { tar.exe -a -cf "$HOME\\${archive}" ${tarExclusions} -C ${windowsPath} . } else { Write-Error 'Config directory not found.' }`
          : `(cd ${unixPath} && zip -r -FS "$HOME/${archive}" . -x ${zipExclusions})`,
    })
  );
}
