import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  createFixTicket,
  findExistingReviewCommentFixTicket,
  getFixTicketById,
} from './fix-tickets';

describe('fix-tickets review comment IDs', () => {
  let testUser: User;

  beforeEach(async () => {
    testUser = await insertTestUser();
  });

  afterEach(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  it.each([2_147_483_648, 2_858_636_454])(
    'handles large GitHub review comment ID %d without integer overflow',
    async reviewCommentId => {
      const repoFullName = `kilo-org/review-comment-id-${reviewCommentId}-${Date.now()}`;

      const existingBefore = await findExistingReviewCommentFixTicket(
        repoFullName,
        reviewCommentId
      );
      expect(existingBefore).toBeNull();

      const ticketId = await createFixTicket({
        owner: { type: 'user', id: testUser.id, userId: testUser.id },
        repoFullName,
        issueNumber: 1,
        issueUrl: `https://github.com/${repoFullName}/issues/1`,
        issueTitle: 'test review comment overflow',
        issueBody: null,
        issueAuthor: 'octocat',
        issueLabels: [],
        triggerSource: 'review_comment',
        reviewCommentId,
        reviewCommentBody: '@kilo fix this',
        filePath: 'src/index.ts',
        lineNumber: 10,
        diffHunk: '@@ -1,1 +1,1 @@',
        prHeadRef: 'feature/test',
      });

      const createdTicket = await getFixTicketById(ticketId);
      expect(createdTicket?.review_comment_id).toBe(reviewCommentId);

      const existingAfter = await findExistingReviewCommentFixTicket(repoFullName, reviewCommentId);
      expect(existingAfter?.id).toBe(ticketId);
    }
  );
});
