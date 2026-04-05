/**
 * Git clone service for building and serving repositories
 * Handles git HTTP protocol
 */

import git from '@ashishkumar472/cf-git';
import { MemFS } from './memfs';
import { logger, formatError } from '../utils/logger';
import { resolveHeadSymref, formatPacketLine } from './git-protocol-utils';
import type { RepositoryBuildOptions } from '../types';

export class GitCloneService {
  /**
   * Build in-memory git repository from exported git objects
   */
  static async buildRepository(options: RepositoryBuildOptions): Promise<MemFS> {
    const { gitObjects } = options;
    const fs = new MemFS();

    try {
      // If no commits yet, create empty repo
      if (gitObjects.length === 0) {
        await git.init({ fs, dir: '/', defaultBranch: 'main' });
        return fs;
      }

      await git.init({ fs, dir: '/', defaultBranch: 'main' });

      // Import all git objects
      for (const obj of gitObjects) {
        await fs.writeFile(obj.path, obj.data);
      }

      logger.debug('Repository built', { gitObjectCount: gitObjects.length });
      return fs;
    } catch (error) {
      logger.error('Failed to build git repository', formatError(error));
      throw new Error(
        `Failed to build repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle git info/refs request
   * Returns advertisement of available refs for git clone
   */
  static async handleInfoRefs(fs: MemFS): Promise<string> {
    try {
      const head = await git.resolveRef({ fs, dir: '/', ref: 'HEAD' });

      // Manually list branches from .git/refs/heads/ to avoid git.listBranches() hanging
      let branches: string[] = [];
      try {
        const headsDir = await fs.readdir('.git/refs/heads');
        branches = headsDir.filter((name: string) => !name.startsWith('.'));
      } catch (err) {
        logger.warn('Failed to list branches', formatError(err));
        branches = [];
      }

      // Determine symref target for HEAD
      const symrefTarget = await resolveHeadSymref(fs, branches);

      // Git HTTP protocol: info/refs response format
      let response = '001e# service=git-upload-pack\n0000';

      // HEAD ref with capabilities (symref first per convention)
      const capabilities = [
        ...(symrefTarget ? [`symref=HEAD:${symrefTarget}`] : []),
        'side-band-64k',
        'thin-pack',
        'ofs-delta',
        'agent=git/isomorphic-git',
      ].join(' ');
      const headLine = `${head} HEAD\0${capabilities}\n`;
      response += formatPacketLine(headLine);

      // Branch refs
      for (const branch of branches) {
        try {
          const oid = await git.resolveRef({
            fs,
            dir: '/',
            ref: `refs/heads/${branch}`,
          });
          response += formatPacketLine(`${oid} refs/heads/${branch}\n`);
        } catch (err) {
          logger.warn('Failed to resolve branch ref', { branch, ...formatError(err) });
        }
      }

      // Flush packet
      response += '0000';

      return response;
    } catch (error) {
      logger.error('Failed to handle info/refs', formatError(error));
      throw new Error(
        `Failed to get refs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle git upload-pack request (actual clone operation)
   * Includes objects reachable from ALL branches for complete repository cloning
   */
  static async handleUploadPack(fs: MemFS): Promise<Uint8Array> {
    try {
      // Collect objects from ALL branches
      const reachableObjects = new Set<string>();

      // Get all branches (same approach as handleInfoRefs to avoid hanging)
      let branches: string[] = [];
      try {
        const headsDir = await fs.readdir('.git/refs/heads');
        branches = headsDir.filter((name: string) => !name.startsWith('.'));
      } catch (err) {
        logger.warn('Failed to list branches for upload-pack', formatError(err));
        branches = [];
      }

      // Collect objects from each branch
      for (const branch of branches) {
        try {
          const commits = await git.log({ fs, dir: '/', ref: branch });

          for (const commit of commits) {
            // Add commit OID
            reachableObjects.add(commit.oid);

            // Walk tree to get all blobs recursively (this also adds the tree OID)
            await this.collectTreeObjects(fs, commit.commit.tree, reachableObjects);
          }
        } catch (err) {
          logger.warn('Failed to walk branch', { branch, ...formatError(err) });
        }
      }

      // Also include HEAD if not already covered (e.g., detached HEAD state)
      try {
        const head = await git.resolveRef({ fs, dir: '/', ref: 'HEAD' });
        if (!reachableObjects.has(head)) {
          reachableObjects.add(head);
          const headCommits = await git.log({ fs, dir: '/', ref: 'HEAD' });
          for (const commit of headCommits) {
            reachableObjects.add(commit.oid);
            await this.collectTreeObjects(fs, commit.commit.tree, reachableObjects);
          }
        }
      } catch (err) {
        logger.warn('Failed to resolve HEAD for upload-pack', formatError(err));
      }

      const packResult = await git.packObjects({
        fs,
        dir: '/',
        oids: Array.from(reachableObjects),
      });

      const packfile = packResult.packfile;

      if (!packfile) {
        throw new Error('Failed to generate packfile');
      }

      // NAK packet: "0008NAK\n"
      const nakPacket = new Uint8Array([0x30, 0x30, 0x30, 0x38, 0x4e, 0x41, 0x4b, 0x0a]);

      // Wrap packfile in sideband format
      const sideband = this.wrapInSideband(packfile);

      // Concatenate NAK + sideband packfile
      const result = new Uint8Array(nakPacket.length + sideband.length);
      result.set(nakPacket, 0);
      result.set(sideband, nakPacket.length);

      return result;
    } catch (error) {
      logger.error('Failed to handle upload-pack', formatError(error));
      throw new Error(
        `Failed to generate pack: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Recursively collect tree objects (trees and blobs)
   */
  private static async collectTreeObjects(
    fs: MemFS,
    treeOid: string,
    objects: Set<string>
  ): Promise<void> {
    if (objects.has(treeOid)) return; // Already collected

    objects.add(treeOid);

    try {
      const treeData = await git.readTree({ fs, dir: '/', oid: treeOid });

      for (const entry of treeData.tree) {
        // If it's a tree, recurse (don't add OID here - the recursive call will add it)
        if (entry.type === 'tree') {
          await this.collectTreeObjects(fs, entry.oid, objects);
        } else {
          // For blobs, add directly
          objects.add(entry.oid);
        }
      }
    } catch (err) {
      logger.warn('Failed to read tree', { treeOid, ...formatError(err) });
    }
  }

  /**
   * Wrap packfile in sideband-64k format
   */
  private static wrapInSideband(packfile: Uint8Array): Uint8Array {
    const CHUNK_SIZE = 65515;
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < packfile.length) {
      const chunkSize = Math.min(CHUNK_SIZE, packfile.length - offset);
      const chunk = packfile.slice(offset, offset + chunkSize);

      const packetLength = 4 + 1 + chunkSize;
      const lengthHex = packetLength.toString(16).padStart(4, '0');
      const packet = new Uint8Array(4 + 1 + chunkSize);
      for (let i = 0; i < 4; i++) {
        packet[i] = lengthHex.charCodeAt(i);
      }
      packet[4] = 0x01;
      packet.set(chunk, 5);

      chunks.push(packet);
      offset += chunkSize;
    }

    const flush = new Uint8Array([0x30, 0x30, 0x30, 0x30]);
    chunks.push(flush);
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let resultOffset = 0;
    for (const chunk of chunks) {
      result.set(chunk, resultOffset);
      resultOffset += chunk.length;
    }

    return result;
  }
}
