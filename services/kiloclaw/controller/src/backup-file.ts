import fs from 'node:fs';
import path from 'node:path';

const MAX_BACKUPS = 5;
const BACKUP_DIR = '.kilo-backups';

export interface BackupFileDeps {
  copyFileSync: typeof fs.copyFileSync;
  mkdirSync: typeof fs.mkdirSync;
  readdirSync: typeof fs.readdirSync;
  unlinkSync: typeof fs.unlinkSync;
}

const defaultDeps: BackupFileDeps = {
  copyFileSync: fs.copyFileSync,
  mkdirSync: fs.mkdirSync,
  readdirSync: fs.readdirSync,
  unlinkSync: fs.unlinkSync,
};

function sanitizeName(filePath: string, rootDir: string): string {
  return path.relative(rootDir, filePath).replace(/\//g, '__');
}

export function backupFile(
  filePath: string,
  rootDir: string,
  deps: BackupFileDeps = defaultDeps
): void {
  const backupDir = path.join(rootDir, BACKUP_DIR);
  deps.mkdirSync(backupDir, { recursive: true });

  const sanitized = sanitizeName(filePath, rootDir);
  const backupName = `${sanitized}.${Date.now()}.bak`;

  deps.copyFileSync(filePath, path.join(backupDir, backupName));

  const entries = deps.readdirSync(backupDir) as string[];
  const backupPrefix = `${sanitized}.`;
  const backups = entries.filter(e => e.startsWith(backupPrefix) && e.endsWith('.bak')).sort();

  while (backups.length > MAX_BACKUPS) {
    const oldest = backups.shift()!;
    deps.unlinkSync(path.join(backupDir, oldest));
  }
}
