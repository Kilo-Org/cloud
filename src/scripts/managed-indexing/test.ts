import { readdirSync, readFileSync, statSync } from 'fs';
import { eq } from 'drizzle-orm';
import { join, relative, resolve } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';
import pLimit from 'p-limit';
import { getAuthToken } from '@/scripts/lib/auth';
import { generateApiToken } from '@/lib/tokens';
import { z } from 'zod';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';

// Types
type ManifestResponse = {
  organizationId: string | null;
  projectId: string;
  gitBranch: string;
  files: Record<string, string>; // Map of fileHash to filePath
  totalFiles: number;
  lastUpdated: string;
};

type SearchResult = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  gitBranch: string;
  fromPreferredBranch: boolean;
};

type UploadResult = {
  success: boolean;
  chunksProcessed?: number;
  error?: string;
};

type AuthConfig = {
  authToken: string;
  baseUrl: string;
  organizationId: string | null;
};

// Constants
const DEFAULT_GIT_BRANCH = 'main';
const DEFAULT_SEARCHES = [
  { name: 'Organization Role Changes', query: 'organization change role permissions member' },
  { name: 'Token Usage Tracking', query: 'tracking spend on token usage billing' },
  { name: 'Credit Transactions', query: 'credit transactions payment stripe' },
  { name: 'Code Indexing', query: 'code indexing embeddings vector search' },
  { name: 'Authentication', query: 'authentication login sign in token' },
  { name: 'Self-search', query: 'script to test qdrant' },
];

// Authentication
async function getAuthConfig(organizationId: string): Promise<AuthConfig> {
  console.log('🔑 Generating authentication token...');
  if (z.uuid().safeParse(organizationId).success) {
    console.log(`   Organization ID: ${organizationId}`);
    const authToken = await getAuthToken(organizationId);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    console.log('   ✅ Token generated successfully');
    return { authToken, baseUrl, organizationId };
  } else {
    const user = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, organizationId))
      .limit(1);
    if (!user || user.length === 0) {
      throw new Error(`User with email ${organizationId} not found`);
    }

    console.log(`   User Email: ${organizationId}`);
    const authToken = generateApiToken(user[0]);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    console.log('   ✅ Token generated successfully');
    return { authToken, baseUrl, organizationId: null };
  }
}

// File operations
function findTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules, .git, and other common directories
      if (!['node_modules', '.git', '.next', 'dist', 'build', '.turbo'].includes(entry.name)) {
        files.push(...findTypeScriptFiles(fullPath));
      }
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }

  return files;
}

function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

// API operations
async function uploadFile(
  filePath: string,
  organizationId: string | null,
  projectId: string,
  gitBranch: string,
  baseUrl: string,
  authToken: string
): Promise<UploadResult> {
  const fileContent = readFileSync(filePath);
  const fileHash = computeFileHash(filePath);
  const workspaceRoot = process.cwd();
  const relativeFilePath = relative(workspaceRoot, filePath);

  const formData = new FormData();
  const blob = new Blob([fileContent], { type: 'text/plain' });
  const file = new File([blob], relativeFilePath, { type: 'text/plain' });

  formData.append('file', file);
  if (organizationId) {
    formData.append('organizationId', organizationId);
  }
  formData.append('projectId', projectId);
  formData.append('filePath', relativeFilePath);
  formData.append('fileHash', fileHash);
  formData.append('gitBranch', gitBranch);
  formData.append('isBaseBranch', 'true');

  try {
    const response = await fetch(`${baseUrl}/api/code-indexing/upsert-by-file`, {
      method: 'PUT',
      body: formData,
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      return {
        success: false,
        error: errorData.error || errorData.message || `HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    return { success: true, chunksProcessed: data.chunksProcessed };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function fetchManifest(
  organizationId: string | null,
  projectId: string,
  gitBranch: string,
  baseUrl: string,
  authToken: string
): Promise<ManifestResponse> {
  const url = new URL(`${baseUrl}/api/code-indexing/manifest`);
  if (organizationId) url.searchParams.set('organizationId', organizationId);
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('gitBranch', gitBranch);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    // If manifest doesn't exist yet (404), return empty manifest
    if (response.status === 404 || response.status === 400) {
      return {
        organizationId,
        projectId,
        gitBranch,
        files: {},
        totalFiles: 0,
        lastUpdated: new Date().toISOString(),
      };
    }
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(errorData.error || errorData.message || `HTTP ${response.status}`);
  }

  return response.json() as Promise<ManifestResponse>;
}

async function performSearch(
  query: string,
  organizationId: string | null,
  projectId: string,
  baseUrl: string,
  authToken: string
): Promise<SearchResult[]> {
  const response = await fetch(`${baseUrl}/api/code-indexing/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...(organizationId && { organizationId }),
      projectId,
      query,
      fallbackBranch: DEFAULT_GIT_BRANCH,
    }),
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.error || errorData.message || JSON.stringify(errorData);
    } catch {
      // If response is not JSON, try to get text
      try {
        const errorText = await response.text();
        if (errorText) {
          errorMessage = errorText;
        }
      } catch {
        // Keep the HTTP status message
      }
    }
    throw new Error(errorMessage);
  }

  return response.json() as Promise<SearchResult[]>;
}

// Display functions
function displaySearchResults(searchName: string, query: string, results: SearchResult[]): void {
  console.log(`\n📝 ${searchName} (${results.length} results)`);
  console.log(`   Query: "${query}"`);

  if (results.length === 0) {
    console.log('   No results found');
    return;
  }

  results.forEach((result, index) => {
    console.log(
      `   ${index + 1}. ${result.filePath}:${result.startLine}-${result.endLine} | score: ${result.score.toFixed(3)} | ${result.gitBranch}`
    );
  });
}

// Main operations
async function indexFiles(
  organizationId: string | null,
  projectId: string,
  gitBranch: string,
  baseUrl: string,
  authToken: string,
  folderPath: string
): Promise<void> {
  console.log('🚀 Starting code indexing...');
  console.log(`   Organization ID: ${organizationId}`);
  console.log(`   Project ID: ${projectId}`);
  console.log(`   Git Branch: ${gitBranch}`);
  console.log(`   Base URL: ${baseUrl}`);
  console.log('');

  // Fetch existing manifest to check which files need updating
  console.log('📋 Fetching existing manifest...');
  let existingManifest: ManifestResponse;
  try {
    existingManifest = await fetchManifest(
      organizationId,
      projectId,
      gitBranch,
      baseUrl,
      authToken
    );
    console.log(
      `   Found ${Object.keys(existingManifest.files).length} files in existing manifest`
    );
  } catch (error) {
    console.error(
      '   ⚠️  Could not fetch manifest:',
      error instanceof Error ? error.message : error
    );
    console.log('   Proceeding to index all files...');
    existingManifest = {
      organizationId,
      projectId,
      gitBranch,
      files: {},
      totalFiles: 0,
      lastUpdated: new Date().toISOString(),
    };
  }
  console.log('');

  // Create a map of file paths to their file hash signatures
  // Note: manifest is fileHash -> filePath, but we need filePath -> fileHash
  // If a file appears multiple times with different hashes, we keep the most recent (last one)
  const manifestMap = new Map<string, string>();
  for (const [fileHash, filePath] of Object.entries(existingManifest.files)) {
    manifestMap.set(filePath, fileHash);
  }

  // Resolve the folder path (handle relative, absolute, and ~/ paths)
  let srcDir: string;
  if (folderPath.startsWith('~/')) {
    srcDir = join(homedir(), folderPath.slice(2));
  } else if (folderPath.startsWith('/')) {
    srcDir = folderPath;
  } else {
    srcDir = resolve(process.cwd(), folderPath);
  }
  console.log(`📂 Scanning for TypeScript files in: ${srcDir}`);

  const allFiles = findTypeScriptFiles(srcDir);
  console.log(`   Found ${allFiles.length} TypeScript files`);
  console.log('');

  // Filter files that need to be uploaded
  // A file needs indexing if:
  // 1. It's not in the manifest at all, OR
  // 2. The file hash has changed (content was modified)
  console.log('🔍 Checking which files need indexing...');
  const filesToUpload = allFiles.filter(file => {
    const relPath = relative(process.cwd(), file);
    const manifestHash = manifestMap.get(relPath);

    // one in 100 files should randomly be re-uploaded to test the file deletion path
    if (Math.random() < 0.01) {
      console.log(`   ⚠️  Randomly re-uploading ${relPath} for testing`);
      return true;
    }

    // If file not in manifest, it needs indexing
    if (!manifestHash) {
      return true;
    }

    // If file hash changed, it needs re-indexing
    const currentHash = computeFileHash(file);
    if (currentHash !== manifestHash) {
      return true;
    }

    return false;
  });

  const skippedCount = allFiles.length - filesToUpload.length;
  console.log(`   📦 ${filesToUpload.length} files need indexing`);
  console.log(`   ⏭️  ${skippedCount} files already indexed (skipped)`);
  console.log('');

  if (filesToUpload.length === 0) {
    console.log('✅ All files are already indexed!');
    console.log('');
    return;
  }

  // Index files with concurrency limit
  console.log('📤 Indexing files (up to 10 concurrent requests)...');
  let successCount = 0;
  let totalChunks = 0;
  let completedCount = 0;

  const limit = pLimit(10);

  const uploadPromises = filesToUpload.map(file => {
    return limit(async () => {
      const relPath = relative(process.cwd(), file);
      const fileSize = statSync(file).size;

      process.stdout.write(
        `   [${completedCount + 1}/${filesToUpload.length}] ${relPath} (${fileSize} bytes)... `
      );

      const result = await uploadFile(
        file,
        organizationId,
        projectId,
        gitBranch,
        baseUrl,
        authToken
      );

      completedCount++;

      if (result.success) {
        successCount++;
        totalChunks += result.chunksProcessed || 0;
        console.log(`✅ ${result.chunksProcessed} chunks`);
      } else {
        console.log(`❌ ${result.error}`);
        console.error('');
        console.error(`❌ Failed to index file: ${relPath}`);
        console.error(`   Error: ${result.error}`);
        console.error('');
        console.error('Exiting early due to upload failure.');
        process.exit(1);
      }

      return result;
    });
  });

  await Promise.all(uploadPromises);

  console.log('');
  console.log(`📊 Indexing complete:`);
  console.log(`   ✅ Success: ${successCount} files`);
  console.log(`   ⏭️  Skipped: ${skippedCount} files`);
  console.log(`   📦 Total chunks: ${totalChunks}`);
  console.log('');

  // Fetch and display final manifest
  console.log('📋 Fetching final manifest...');
  try {
    const startTime = Date.now();
    const manifest = await fetchManifest(organizationId, projectId, gitBranch, baseUrl, authToken);
    const elapsedTime = Date.now() - startTime;

    const distinctFilesCount = Object.keys(manifest.files).length;
    console.log('');
    console.log(`📊 Final Manifest:`);
    console.log(`   Distinct files: ${distinctFilesCount}`);
    console.log(`   Fetch time: ${elapsedTime}ms`);
    console.log('');
  } catch (error) {
    console.error('');
    console.error('❌ Error fetching manifest:', error instanceof Error ? error.message : error);
  }
}

async function runSearches(
  organizationId: string | null,
  projectId: string,
  baseUrl: string,
  authToken: string
): Promise<void> {
  console.log('\n🔍 Starting code search...');
  console.log(`   Organization ID: ${organizationId}`);
  console.log(`   Project ID: ${projectId}`);
  console.log(`   Base URL: ${baseUrl}`);

  // Track search timings
  const searchTimings: Array<{ query: string; name: string; timeMs: number }> = [];

  // Perform default searches
  for (const search of DEFAULT_SEARCHES) {
    try {
      const startTime = Date.now();
      const results = await performSearch(
        search.query,
        organizationId,
        projectId,
        baseUrl,
        authToken
      );
      const elapsedTime = Date.now() - startTime;

      searchTimings.push({ query: search.query, name: search.name, timeMs: elapsedTime });

      displaySearchResults(search.name, search.query, results);
    } catch (error) {
      console.log(`\n❌ ${search.name}`);
      console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Display timing summary
  console.log('\n⏱️  Search Timing Summary:');
  console.log('   ─────────────────────────────────────────────────────────────────');
  for (const timing of searchTimings) {
    console.log(`   ${timing.name}`);
    console.log(`   Query: "${timing.query}"`);
    console.log(`   Time: ${timing.timeMs}ms`);
    console.log('   ─────────────────────────────────────────────────────────────────');
  }

  console.log('\n✨ Search complete!');
}

/**
 * Main test function
 * Indexes all TypeScript files in the specified folder and performs searches
 *
 * @param orgId - Organization ID or user email
 * @param projectId - Project identifier (default: 'test-project')
 * @param folderPath - Path to folder containing files to index (relative, absolute, or ~/path)
 */
export async function run(
  orgId: string,
  projectId: string = 'test-project',
  folderPath: string = './src'
): Promise<void> {
  const { authToken, baseUrl, organizationId } = await getAuthConfig(orgId);

  const gitBranch = DEFAULT_GIT_BRANCH;

  // First, index files
  await indexFiles(organizationId, projectId, gitBranch, baseUrl, authToken, folderPath);

  // Then, perform searches
  await runSearches(organizationId, projectId, baseUrl, authToken);

  console.log('\n✨ Test complete!');
}
