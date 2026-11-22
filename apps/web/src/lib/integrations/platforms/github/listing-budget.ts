export const MAX_GITHUB_PAGINATION_PAGES = 100;
export const MAX_GITHUB_PAGINATION_ITEMS = 10_000;

/** Cumulative response bytes one paginated read keeps across its pages. */
export const MAX_GITHUB_LISTING_BYTES = 16 * 1024 * 1024;

/** Total duration of one paginated read, shared by every page request. */
export const GITHUB_LISTING_TIMEOUT_MS = 60_000;

/** User-facing copy for a listing that exceeded the pagination budget. */
export const GITHUB_LISTING_BUDGET_MESSAGE =
  'This GitHub installation has more repositories or branches than Kilo can list. Limit its repository access and try again.';

/** The installation administration read. */
export const GITHUB_INSTALLATION_ADMINISTRATION_LISTING = 'installation administration listing';

/** Raised when one paginated read passes a page, item, byte or duration bound. */
export class GitHubListingBudgetExceededError extends Error {
  readonly listing: string | null;

  constructor(message: string, listing: string | null = null) {
    super(message);
    this.name = 'GitHubListingBudgetExceededError';
    this.listing = listing;
  }
}

/** Whether a read that passed the bound is the installation administration read. */
export function isInstallationAdministrationListingOverflow(error: unknown): boolean {
  return (
    error instanceof GitHubListingBudgetExceededError &&
    error.listing === GITHUB_INSTALLATION_ADMINISTRATION_LISTING
  );
}

/** One paginated read's budget: retained bytes and the shared deadline signal. */
export class GitHubListingBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly context: string;
  private readonly timer: NodeJS.Timeout;
  private readonly timeoutError: GitHubListingBudgetExceededError;
  private retainedBytes = 0;

  constructor(context: string) {
    this.context = context;
    this.timeoutError = new GitHubListingBudgetExceededError(
      `GitHub pagination limit exceeded: ${context} did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`,
      context
    );
    this.timer = setTimeout(() => {
      // undici rejects with the abort reason itself, and Octokit's fetch wrapper rethrows that
      // rejection unchanged only when its name is `AbortError`; any other reason is wrapped in a
      // RequestError 500. The reason therefore carries the typed error as its cause, and the
      // paginating loops read it back through deadlineError().
      const abortReason = new Error(this.timeoutError.message);
      abortReason.name = 'AbortError';
      Object.defineProperty(abortReason, 'cause', { value: this.timeoutError });
      this.controller.abort(abortReason);
    }, GITHUB_LISTING_TIMEOUT_MS);
    this.timer.unref?.();
    this.signal = this.controller.signal;
  }

  /**
   * The typed deadline error. A page request aborted by the timeout reaches its caller as an
   * `AbortError` or a wrapper around it, so a loop whose signal has fired reports this instead.
   */
  deadlineError(): GitHubListingBudgetExceededError {
    return this.timeoutError;
  }

  retain(bytes: number): void {
    this.retainedBytes += bytes;
    if (this.retainedBytes > MAX_GITHUB_LISTING_BYTES) {
      throw new GitHubListingBudgetExceededError(
        `GitHub pagination limit exceeded: ${this.context} returned more than ${MAX_GITHUB_LISTING_BYTES / (1024 * 1024)} MiB`,
        this.context
      );
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** Runs one page request and reports the budget's typed error when the read ran out of time. */
export async function withListingDeadline<T>(
  budget: GitHubListingBudget,
  request: () => Promise<T>
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (budget.signal.aborted) throw budget.deadlineError();
    throw error;
  }
}

/** Enforces the page and item bounds of every paginating read in this module. */
export function checkGitHubPaginationBounds(
  page: number,
  itemCount: number,
  context: string
): void {
  if (page > MAX_GITHUB_PAGINATION_PAGES) {
    throw new GitHubListingBudgetExceededError(
      `GitHub pagination limit exceeded: ${context} returned more than ${MAX_GITHUB_PAGINATION_PAGES} pages`,
      context
    );
  }
  if (itemCount > MAX_GITHUB_PAGINATION_ITEMS) {
    throw new GitHubListingBudgetExceededError(
      `GitHub pagination limit exceeded: ${context} returned more than ${MAX_GITHUB_PAGINATION_ITEMS} items`,
      context
    );
  }
}
