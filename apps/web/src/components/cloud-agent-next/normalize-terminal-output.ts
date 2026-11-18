import { stripAnsi } from '@/lib/stripAnsi';

export function normalizeTerminalOutput(output: string): string {
  return stripAnsi(output)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => {
      if (!line.includes('\r')) return line;
      const frames = line.split('\r');
      for (let index = frames.length - 1; index >= 0; index--) {
        if (frames[index] !== '') return frames[index];
      }
      return '';
    })
    .join('\n');
}
