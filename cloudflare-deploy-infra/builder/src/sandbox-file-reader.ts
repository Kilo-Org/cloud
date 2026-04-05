/**
 * Sandbox File Reader - Utilities for reading files from Cloudflare Sandbox.
 */

import type { ExecutionSession } from '@cloudflare/sandbox';
import { type getSandbox } from '@cloudflare/sandbox';
import { extract, type Headers } from 'tar-stream';
import { pipeline } from 'stream/promises';
import { Readable, type PassThrough } from 'stream';
import type { DeploymentFile } from './types';
import { getMimeType } from './utils';

// Type for the sandbox stub returned by getSandbox()
type SandboxStub = Awaited<ReturnType<typeof getSandbox>>;

/**
 * List all files recursively in a directory using the sandbox.
 *
 * @param sandbox - The Cloudflare Sandbox instance
 * @param root - Root directory path to search (e.g., "/workspace/result/assets")
 * @returns Array of file paths relative to root
 */
export async function listFilesRecursive(sandbox: SandboxStub, root: string): Promise<string[]> {
  // Execute find command to list all files recursively
  const result = await sandbox.exec(`find ${root} -type f`);

  if (!result.success) {
    throw new Error(`Failed to list files in ${root}: ${result.stderr}`);
  }

  if (!result.stdout) {
    // Empty directory is valid, return empty array
    return [];
  }

  // Parse output into file paths
  const files = result.stdout
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .map((path: string) => {
      // Strip root prefix to get relative paths
      if (path.startsWith(root)) {
        const relativePath = path.slice(root.length);
        // Remove leading slash if present
        return relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
      }
      return path;
    })
    .filter((path: string) => path.length > 0);

  return files;
}

// This is an alternative to sandbox.readFileStream
// sandbox.readFileStream doesn't work with files bigger than 10mb due to internal issues
// switch back once it is fixed in the lib
export async function readFileAsBuffer(session: ExecutionSession, path: string): Promise<Buffer> {
  // Escape path for shell command
  const escapedPath = path.replace(/'/g, "'\\''");

  // First, get file metadata to determine size and if it's binary
  const statResult = await session.exec(`stat -c '%s' '${escapedPath}' 2>/dev/null`);

  if (!statResult.success || statResult.exitCode !== 0) {
    throw new Error(`Failed to stat file ${path}: ${statResult.stderr}`);
  }

  const fileSize = parseInt(statResult.stdout.trim(), 10);
  if (isNaN(fileSize)) {
    throw new Error(`Invalid file size for ${path}`);
  }

  // Read file in chunks
  const chunkSize = 65535 * 40;
  let bytesRead = 0;
  let blockNumber = 0;
  const chunks: Buffer[] = [];
  const maxIterations = Math.ceil(fileSize / chunkSize) + 10; // Expected iterations + safety buffer
  let iterations = 0;

  while (bytesRead < fileSize) {
    if (iterations >= maxIterations) {
      throw new Error(
        `Maximum iterations (${maxIterations}) exceeded while reading file ${path}. ` +
          `Read ${bytesRead} of ${fileSize} bytes.`
      );
    }
    iterations++;

    const skip = blockNumber;
    const count = 1;

    const command = `dd if='${escapedPath}' bs=${chunkSize} skip=${skip} count=${count} 2>/dev/null | base64 -w 0`;

    const execResult = await session.exec(command);

    if (!execResult.success) {
      throw new Error(`Failed to read chunk at offset ${bytesRead}: Command execution failed`);
    }

    if (execResult.exitCode !== 0) {
      throw new Error(`Failed to read chunk at offset ${bytesRead}: ${execResult.stderr}`);
    }

    const chunkData = execResult.stdout;

    if (chunkData.length === 0) {
      // End of file
      break;
    }

    // Convert chunk to Buffer
    const chunkBuffer = Buffer.from(chunkData, 'base64');
    chunks.push(chunkBuffer);

    bytesRead += chunkBuffer.length;
    blockNumber++;
  }

  // Concatenate all chunks into a single Buffer
  return Buffer.concat(chunks);
}

/**
 * Read a folder from the sandbox by creating a tar archive, reading it, and extracting locally.
 * This is useful for efficiently transferring entire directory structures from the sandbox.
 *
 * @param session - The Cloudflare Sandbox ExecutionSession instance
 * @param folderPath - Absolute path to the folder in the sandbox
 * @param excludePatterns - Optional array of patterns to exclude (e.g., ['node_modules', '*.log', '.git'])
 * @returns Array of DeploymentFile objects with paths relative to the archived folder and their contents as buffers
 */
export async function readFolderAsArchive(
  session: ExecutionSession,
  folderPath: string,
  excludePatterns?: string[]
): Promise<DeploymentFile[]> {
  // Escape path for shell command
  const escapedPath = folderPath.replace(/'/g, "'\\''");

  // Create a temporary tar file in the sandbox using a UUID
  const tmpArchivePath = `/tmp/folder-archive-${crypto.randomUUID()}.tar`;
  const escapedArchivePath = tmpArchivePath.replace(/'/g, "'\\''");

  const excludeFlags = excludePatterns
    ? excludePatterns.map(pattern => `--exclude='${pattern.replace(/'/g, "'\\''")}'`).join(' ')
    : '';

  const tarCommand = `tar -cf '${escapedArchivePath}' ${excludeFlags} -C '${escapedPath}' .`;

  const tarResult = await session.exec(tarCommand);

  if (!tarResult.success || tarResult.exitCode !== 0) {
    throw new Error(`Failed to create tar archive of ${folderPath}: ${tarResult.stderr}`);
  }

  try {
    const archiveBuffer = await readFileAsBuffer(session, tmpArchivePath);

    // Extract the archive
    const files: DeploymentFile[] = [];

    const bufferStream = Readable.from(archiveBuffer);
    const extractStream = extract();

    extractStream.on('entry', (header: Headers, stream: PassThrough, next: () => void) => {
      // Only process files, not directories
      if (header.type === 'file') {
        const chunks: Buffer[] = [];

        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        stream.on('end', () => {
          const fileBuffer = Buffer.concat(chunks);
          const mimeType = getMimeType(header.name);

          // Normalize path: remove leading "./" or "/"
          let normalizedPath = header.name;
          if (normalizedPath.startsWith('./')) {
            normalizedPath = normalizedPath.slice(2);
          } else if (normalizedPath.startsWith('/')) {
            normalizedPath = normalizedPath.slice(1);
          }

          files.push({
            path: normalizedPath,
            content: fileBuffer,
            mimeType,
          });
          next();
        });

        stream.on('error', (err: Error) => {
          throw new Error(`Error reading file ${header.name} from archive: ${err.message}`);
        });
      } else {
        // Skip directories
        stream.resume();
        next();
      }
    });

    // Process the archive
    await pipeline(bufferStream, extractStream);

    return files;
  } finally {
    const cleanupResult = await session.exec(`rm -f '${escapedArchivePath}'`);
    if (!cleanupResult.success) {
      console.warn(
        `Failed to clean up temporary archive ${tmpArchivePath}: ${cleanupResult.stderr}`
      );
    }
  }
}
