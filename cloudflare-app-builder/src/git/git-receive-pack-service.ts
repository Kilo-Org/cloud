/**
 * Git receive-pack service for handling push operations
 * Handles git HTTP protocol for receiving packfiles
 */

import git from '@ashishkumar472/cf-git';
import type { MemFS } from './memfs';
import { logger, formatError } from '../utils/logger';
import type { RefUpdate, ReceivePackResult } from '../types';
import { MAX_OBJECT_SIZE } from './constants';

export type ReceivePackError =
  | { kind: 'global'; message: string }
  | { kind: 'ref'; refName: string; message: string };

/** Collapse newlines and strip control characters so a message is safe for a single pkt-line. */
function sanitizeStatusMessage(msg: string): string {
  return msg.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f]/g, '');
}

export class GitReceivePackService {
  /**
   * Handle info/refs request for receive-pack service
   * Returns refs advertisement for push operations
   */
  static async handleInfoRefs(fs: MemFS): Promise<string> {
    try {
      // Build response with receive-pack service header
      let response = '001f# service=git-receive-pack\n0000';

      // Try to get HEAD ref
      let head: string | null = null;
      try {
        head = await git.resolveRef({ fs, dir: '/', ref: 'HEAD' });
      } catch (err) {
        logger.warn('Failed to resolve HEAD (empty repo?)', formatError(err));
      }

      // Get branches from .git/refs/heads/
      let branches: string[] = [];
      try {
        const headsDir = await fs.readdir('.git/refs/heads');
        branches = headsDir.filter((name: string) => !name.startsWith('.'));
      } catch (err) {
        logger.warn('Failed to list branches', formatError(err));
      }

      // Capabilities for receive-pack
      const capabilities =
        'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=git/isomorphic-git';

      if (head && branches.length > 0) {
        // Existing repo with refs
        const headLine = `${head} HEAD\0${capabilities}\n`;
        response += this.formatPacketLine(headLine);

        // Add branch refs
        for (const branch of branches) {
          try {
            const oid = await git.resolveRef({
              fs,
              dir: '/',
              ref: `refs/heads/${branch}`,
            });
            response += this.formatPacketLine(`${oid} refs/heads/${branch}\n`);
          } catch (err) {
            logger.warn('Failed to resolve branch ref', { branch, ...formatError(err) });
          }
        }
      } else {
        // Empty repo - advertise zero-id for default branch
        const zeroOid = '0000000000000000000000000000000000000000';
        const emptyLine = `${zeroOid} capabilities^{}\0${capabilities}\n`;
        response += this.formatPacketLine(emptyLine);
      }

      // Flush packet
      response += '0000';

      return response;
    } catch (error) {
      logger.error('Failed to handle receive-pack info/refs', formatError(error));
      throw new Error(
        `Failed to get refs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parse pkt-line format data from git client
   */
  static parsePktLines(data: Uint8Array): {
    commands: RefUpdate[];
    packfileStart: number;
  } {
    const commands: RefUpdate[] = [];
    let offset = 0;
    let packfileStart = 0;

    const textDecoder = new TextDecoder();

    while (offset < data.length) {
      // Read 4 byte hex length
      if (offset + 4 > data.length) break;

      const lengthHex = textDecoder.decode(data.slice(offset, offset + 4));
      const length = parseInt(lengthHex, 16);

      // Flush packet
      if (length === 0) {
        offset += 4;
        // After flush, the rest is packfile
        packfileStart = offset;
        break;
      }

      // Read packet content
      const packetData = data.slice(offset + 4, offset + length);
      const packetText = textDecoder.decode(packetData).trim();

      // Skip capabilities line (contains NUL byte)
      if (packetText.includes('\0')) {
        // Parse command before capabilities
        const commandPart = packetText.split('\0')[0];
        const command = this.parseRefUpdateCommand(commandPart);
        if (command) {
          commands.push(command);
        }
      } else {
        // Regular ref update command
        const command = this.parseRefUpdateCommand(packetText);
        if (command) {
          commands.push(command);
        }
      }

      offset += length;
    }

    return { commands, packfileStart };
  }

  /**
   * Parse individual ref update command
   * Format: <old-oid> <new-oid> <ref-name>
   */
  private static parseRefUpdateCommand(line: string): RefUpdate | null {
    const parts = line.trim().split(' ');
    if (parts.length < 3) return null;

    const oldOid = parts[0];
    const newOid = parts[1];
    const refName = parts.slice(2).join(' ').trim();

    if (!oldOid || !newOid || !refName) return null;

    // Validate OID format (40 hex chars)
    if (oldOid.length !== 40 || newOid.length !== 40) return null;

    return { oldOid, newOid, refName };
  }

  /**
   * Handle receive-pack request (actual push operation)
   * Processes packfile and updates refs
   */
  static async handleReceivePack(
    fs: MemFS,
    requestData: Uint8Array
  ): Promise<{ response: Uint8Array; result: ReceivePackResult }> {
    const result: ReceivePackResult = {
      success: true,
      refUpdates: [],
      errors: [],
    };
    // Structured errors for report-status generation (separate from result.errors which is string[])
    const reportErrors: ReceivePackError[] = [];

    try {
      // Parse pkt-line commands and find packfile
      const { commands, packfileStart } = this.parsePktLines(requestData);
      result.refUpdates = commands;
      let indexedOids: Set<string> | undefined;

      // Extract packfile data (skip PACK header check, pass all remaining data)
      if (packfileStart < requestData.length) {
        const packfileData = requestData.slice(packfileStart);

        // Find the actual PACK header in the data
        let packStart = 0;
        for (let i = 0; i < Math.min(packfileData.length - 4, 100); i++) {
          if (
            packfileData[i] === 0x50 && // P
            packfileData[i + 1] === 0x41 && // A
            packfileData[i + 2] === 0x43 && // C
            packfileData[i + 3] === 0x4b
          ) {
            // K
            packStart = i;
            break;
          }
        }

        const actualPackfile = packfileData.slice(packStart);

        if (actualPackfile.length > 0) {
          // PRE-VALIDATION: Check packfile size BEFORE processing
          // This prevents repository corruption by rejecting oversized packs early
          if (actualPackfile.length > MAX_OBJECT_SIZE) {
            const sizeKB = (actualPackfile.length / 1024).toFixed(2);
            const maxKB = (MAX_OBJECT_SIZE / 1024).toFixed(2);
            const errorMsg =
              `Packfile too large: ${sizeKB}KB exceeds ${maxKB}KB limit. ` +
              `This packfile combines multiple git objects. ` +
              `Try:\n` +
              `  1. Push fewer files at once\n` +
              `  2. Reduce file sizes`;

            logger.warn('Packfile size validation failed', {
              packfileSizeKB: sizeKB,
              maxSizeKB: maxKB,
            });

            result.errors.push(errorMsg);
            result.success = false;

            // Return error response immediately - DO NOT index or update refs
            const response = this.generateReportStatus(commands, [
              { kind: 'global', message: errorMsg },
            ]);
            return { response, result };
          }

          // IMPORTANT: Write the packfile to the filesystem BEFORE calling indexPack
          // indexPack reads from this path, so it must exist first!
          // Use a unique name for each pack file to avoid overwriting previous packs
          const packId = `pack-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
          const packPath = `.git/objects/pack/${packId}.pack`;

          // Ensure the pack directory exists
          try {
            await fs.mkdir('.git/objects/pack', { recursive: true });
          } catch (_err) {
            // Directory may already exist, ignore
          }

          await fs.writeFile(packPath, actualPackfile);

          // Use isomorphic-git to index the packfile
          try {
            const indexResult = await git.indexPack({
              fs,
              dir: '/',
              filepath: packPath,
              gitdir: '.git',
            });
            indexedOids = new Set(indexResult.oids);
          } catch (indexError) {
            const errorMessage =
              indexError instanceof Error ? indexError.message : String(indexError);
            const errorStack = indexError instanceof Error ? indexError.stack : undefined;

            logger.error('indexPack failed', {
              error: errorMessage,
              stack: errorStack,
              packPath,
              packfileSize: actualPackfile.length,
              commands: commands.map(c => c.refName),
            });

            // CLEANUP: Remove the corrupted packfile and any partial .idx to prevent leaving partial data
            const idxPath = packPath.replace(/\.pack$/, '.idx');
            for (const filePath of [packPath, idxPath]) {
              try {
                await fs.unlink(filePath);
                logger.info('Cleaned up failed pack artifact', { filePath });
              } catch (cleanupError) {
                // File may not exist (e.g., .idx wasn't written yet) — that's fine
                logger.warn('Failed to cleanup pack artifact', {
                  filePath,
                  cleanupError:
                    cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
              }
            }

            // Don't silently continue - this is a critical error
            // Mark as failed and DON'T proceed with ref updates
            const indexErrorMsg = `Failed to index packfile: ${errorMessage}`;
            result.errors.push(indexErrorMsg);

            // Return error response immediately - DO NOT apply refs with corrupt objects
            result.success = false;
            const response = this.generateReportStatus(commands, [
              { kind: 'global', message: indexErrorMsg },
            ]);
            return { response, result };
          }
        }
      }

      // Apply ref updates — all error paths returned above
      const zeroOid = '0000000000000000000000000000000000000000';

      for (const cmd of commands) {
        try {
          if (cmd.newOid === zeroOid) {
            // Delete ref
            await git.deleteRef({ fs, dir: '/', ref: cmd.refName });
            continue;
          }

          // Validate the target object exists somewhere in the repo
          if (indexedOids && !indexedOids.has(cmd.newOid)) {
            let objectExists = false;
            try {
              await git.readObject({ fs, dir: '/', oid: cmd.newOid });
              objectExists = true;
            } catch {
              // Object not found anywhere in the repo
            }

            if (!objectExists) {
              const errorMsg = `Ref ${cmd.refName} targets object ${cmd.newOid} which was not found in the repository`;
              logger.warn('Ref target not found in repository', {
                refName: cmd.refName,
                newOid: cmd.newOid,
              });
              result.errors.push(errorMsg);
              reportErrors.push({ kind: 'ref', refName: cmd.refName, message: errorMsg });
              continue;
            }
          }

          // Create or update ref
          await git.writeRef({
            fs,
            dir: '/',
            ref: cmd.refName,
            value: cmd.newOid,
            force: true,
          });

          // If this is main/master branch, ensure HEAD points to it symbolically.
          // Only set HEAD when it doesn't already resolve (e.g. first push).
          if (cmd.refName === 'refs/heads/main' || cmd.refName === 'refs/heads/master') {
            let headExists = false;
            try {
              await git.resolveRef({ fs, dir: '/', ref: 'HEAD' });
              headExists = true;
            } catch {
              // HEAD doesn't resolve — needs to be set
            }

            if (!headExists) {
              try {
                await git.writeRef({
                  fs,
                  dir: '/',
                  ref: 'HEAD',
                  value: cmd.refName,
                  force: true,
                  symbolic: true,
                });
              } catch (err) {
                logger.warn('Failed to update HEAD', formatError(err));
              }
            }
          }
        } catch (refError) {
          const errorMsg = `Failed to update ${cmd.refName}: ${
            refError instanceof Error ? refError.message : String(refError)
          }`;
          logger.error('Ref update failed', { refName: cmd.refName, ...formatError(refError) });
          result.errors.push(errorMsg);
          reportErrors.push({ kind: 'ref', refName: cmd.refName, message: errorMsg });
        }
      }

      result.success = result.errors.length === 0;

      // Generate report-status response
      const response = this.generateReportStatus(commands, reportErrors);

      return { response, result };
    } catch (error) {
      logger.error('Failed to handle receive-pack', formatError(error));
      result.success = false;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(errorMsg);

      const response = this.generateReportStatus([], [{ kind: 'global', message: errorMsg }]);
      return { response, result };
    }
  }

  /**
   * Generate report-status response for push.
   * Global errors (pack-size, indexPack failure) mark all refs as ng.
   * Per-ref errors only mark the specific ref as ng.
   */
  static generateReportStatus(commands: RefUpdate[], errors: ReceivePackError[]): Uint8Array {
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();

    const globalError = errors.find(e => e.kind === 'global');

    // Unpack status — only report error for global failures (pack-level).
    // Per-ref failures are reported via ng lines; the pack itself unpacked fine.
    const unpackStatus = globalError ? 'unpack error\n' : 'unpack ok\n';
    chunks.push(this.createSidebandPacket(1, encoder.encode(this.formatPacketLine(unpackStatus))));

    // Ref statuses
    for (const cmd of commands) {
      let status: string;
      if (globalError) {
        // Global failure applies to all refs
        status = `ng ${cmd.refName} ${sanitizeStatusMessage(globalError.message)}\n`;
      } else {
        const refError = errors.find(e => e.kind === 'ref' && e.refName === cmd.refName);
        status = refError
          ? `ng ${cmd.refName} ${sanitizeStatusMessage(refError.message)}\n`
          : `ok ${cmd.refName}\n`;
      }
      chunks.push(this.createSidebandPacket(1, encoder.encode(this.formatPacketLine(status))));
    }

    // Flush packet for sideband
    chunks.push(this.createSidebandPacket(1, encoder.encode('0000')));

    // Final flush packet
    chunks.push(encoder.encode('0000'));

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  /**
   * Create a sideband packet
   */
  private static createSidebandPacket(band: number, data: Uint8Array): Uint8Array {
    const length = 4 + 1 + data.length; // length header + band byte + data
    const lengthHex = length.toString(16).padStart(4, '0');
    const packet = new Uint8Array(length);

    // Write length
    for (let i = 0; i < 4; i++) {
      packet[i] = lengthHex.charCodeAt(i);
    }

    // Write band number
    packet[4] = band;

    // Write data
    packet.set(data, 5);

    return packet;
  }

  /**
   * Format git packet line (4-byte hex length prefix + data).
   * The length counts UTF-8 encoded bytes (not JS string length) per the git protocol spec.
   */
  private static formatPacketLine(data: string): string {
    const byteLength = new TextEncoder().encode(data).length;
    const hexLength = (byteLength + 4).toString(16).padStart(4, '0');
    return hexLength + data;
  }

  /**
   * Export all git objects from MemFS for persisting to storage
   */
  static exportGitObjects(fs: MemFS): Array<{ path: string; data: Uint8Array }> {
    const exported: Array<{ path: string; data: Uint8Array }> = [];

    // Access internal files map - MemFS stores files without leading slash
    // We need to iterate through all .git/ files
    const files = (fs as unknown as { files: Map<string, Uint8Array> }).files;

    for (const [path, data] of files.entries()) {
      if (path.startsWith('.git/')) {
        exported.push({ path, data });
      }
    }

    return exported;
  }
}
