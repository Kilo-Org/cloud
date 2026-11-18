import { useEffect, useState } from 'react';

/**
 * The relative launch folder the folder picker confirmed (`""` = the launch
 * directory). A folder choice belongs to one instance's launch directory:
 * switching connection (or back to Cloud Agent) discards it so a stale
 * relative path never rides a different launch directory.
 */
export function useLaunchFolder(
  connectionId: string | undefined
): readonly [folderPath: string, setFolderPath: (next: string) => void] {
  const [folderPath, setFolderPath] = useState('');

  useEffect(() => {
    setFolderPath('');
  }, [connectionId]);

  return [folderPath, setFolderPath] as const;
}
