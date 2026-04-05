export type Logger = (message: string, ...args: unknown[]) => void;

export type ChunkWithMetadata = {
  text: string;
  startLine: number;
  endLine: number;
  organizationId: string;
  userId: string | null;
  projectId: string;
  filePath: string;
  fileHash: string;
  gitBranch: string;
  isBaseBranch: boolean;
};

export type DeleteByFilePathParams = {
  organizationId: string;
  projectId: string;
  gitBranch: string;
  filePath: string;
};

export type DeleteParams = {
  organizationId: string;
  projectId: string;
  gitBranch?: string;
  filePaths?: string[];
};

export type SearchParams = {
  query: string;
  organizationId: string;
  projectId: string;
  path?: string;
  preferBranch?: string;
  fallbackBranch: string;
  excludeFiles: string[];
};

export type SearchResult = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  gitBranch: string;
  fromPreferredBranch: boolean;
};

export type GetManifestParams = {
  organizationId: string;
  projectId: string;
  gitBranch: string;
};

export type ManifestResult = {
  organizationId: string;
  projectId: string;
  gitBranch: string;
  files: Record<string, string>; // Map of fileHash to filePath
  totalFiles: number;
  lastUpdated: string;
  totalLines: number;
  totalAILines: number;
  percentageOfAILines: number;
};
