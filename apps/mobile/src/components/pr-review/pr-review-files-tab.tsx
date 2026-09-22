import { PrReviewFileList } from '@/components/pr-review/diff/pr-diff-file-list';

type PrReviewFilesTabProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Head SHA at the time the Overview was loaded — keeps the file list stable. */
  readonly headSha: string;
  /** File count from the Overview DTO for the >3,000-file truncation banner. */
  readonly changedFiles: number;
  /** Invoked by the empty state ("0 changed files") to jump back to Overview. */
  readonly onRequestOverview?: () => void;
};

/**
 * Files tab: hosts the S6b diff file list (a virtualized FlashList, so the
 * screen renders this outside its Overview ScrollView). S6c layers the file
 * navigator sheet and the tablet unified/side-by-side toggle on top of this.
 *
 * Provider-agnostic (s5): the identity below is the GitHub-shaped triple the
 * list and its stores are written against, while the list's own queries
 * (`usePrReviewFileListQuery`, `usePrDiffContextLoader`) resolve the real
 * `ProviderPrRef` from the provider scope, so the same list renders GitLab
 * and Bitbucket diffs without a per-provider copy of this tree.
 */
export function PrReviewFilesTab({
  owner,
  repo,
  number,
  headSha,
  changedFiles,
  onRequestOverview,
}: PrReviewFilesTabProps) {
  return (
    <PrReviewFileList
      owner={owner}
      repo={repo}
      number={number}
      headSha={headSha}
      changedFiles={changedFiles}
      onRequestOverview={onRequestOverview}
    />
  );
}
