/**
 * Internal API Endpoint: Check for Duplicate Issues
 *
 * Called by:
 * - Triage Orchestrator (Cloudflare Worker) to check for duplicate issues
 *
 * Process:
 * 1. Get ticket from database
 * 2. Generate embedding using Mistral
 * 3. Store embedding in Milvus (if not already stored)
 * 4. Search Milvus for similar tickets
 * 5. Return similarity candidates — the caller (worker) decides via LLM reasoning
 *
 * URL: POST /api/internal/triage/check-duplicates
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getTriageTicketById, updateTriageTicketStatus } from '@/lib/auto-triage/db/triage-tickets';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { createEmbeddingService } from '@/lib/embeddings/embedding-providers';
import { getMilvusClient } from '@/lib/code-indexing/milvus';
import { createHash } from 'crypto';

const COLLECTION_NAME = 'auto_triage_tickets';
const SIMILARITY_THRESHOLD = 0.8; // Adjusted for Mistral embeddings
const SEARCH_LIMIT = 5;

type CheckDuplicatesRequest = {
  ticketId: string;
  threshold?: number;
  limit?: number;
};

type SimilarTicket = {
  ticketId: string;
  issueNumber: number;
  issueTitle: string;
  similarity: number;
  repoFullName: string;
};

/**
 * Similarity candidates returned to the caller.
 * The final duplicate decision is made by the worker via LLM reasoning.
 */
type CheckDuplicatesResponse = {
  similarTickets: SimilarTicket[];
};

/**
 * Preprocess issue text for embedding
 * Removes code blocks, inline code, links, and markdown formatting
 */
function preprocessIssueText(title: string, body: string | null): string {
  const combined = `${title}\n\n${body || ''}`;
  return combined
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/`[^`]+`/g, '') // Remove inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links
    .replace(/[#*_~]/g, '') // Remove markdown
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 32000); // Truncate to ~8000 tokens
}

// Helper to escape string values for Milvus filter expressions
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Generate and store embedding for a ticket
 */
async function generateAndStoreEmbedding(
  ticketId: string,
  organizationId: string,
  repoFullName: string,
  issueNumber: number,
  issueTitle: string,
  issueBody: string | null
): Promise<string> {
  // 1. Preprocess text
  const sourceText = preprocessIssueText(issueTitle, issueBody);

  // 2. Generate embedding using Mistral
  const embeddingService = createEmbeddingService('mistral-text');
  const { embedding } = await embeddingService.embedSingle(sourceText);

  // 3. Generate point ID (MD5 hash of unique identifier)
  const idString = `${organizationId}|${repoFullName}|${issueNumber}`;
  const pointId = createHash('md5').update(idString).digest('hex');

  // 4. Store in Milvus
  await getMilvusClient().upsert({
    collection_name: COLLECTION_NAME,
    data: [
      {
        id: pointId,
        vector: embedding,
        ticket_id: ticketId,
        organization_id: organizationId,
        repo_full_name: repoFullName,
        issue_number: issueNumber,
        issue_title: issueTitle,
        source_text: sourceText,
        created_at: Date.now(),
      },
    ],
  });

  logExceptInTest('[check-duplicates] Stored embedding in Milvus', {
    ticketId,
    pointId,
    embeddingDimensions: embedding.length,
  });

  return pointId;
}

/**
 * Search for similar tickets in Milvus
 */
async function findSimilarTickets(
  currentTicketId: string,
  issueTitle: string,
  issueBody: string | null,
  organizationId: string,
  repoFullName: string,
  threshold: number,
  limit: number
): Promise<SimilarTicket[]> {
  // 1. Generate embedding for search
  const embeddingService = createEmbeddingService('mistral-text');
  const sourceText = preprocessIssueText(issueTitle, issueBody);
  const { embedding } = await embeddingService.embedSingle(sourceText);

  // 2. Build filter expression for Milvus
  const filter = `organization_id == "${escapeFilterValue(organizationId)}" && repo_full_name == "${escapeFilterValue(repoFullName)}"`;

  // 3. Search Milvus
  const searchResults = await getMilvusClient().search({
    collection_name: COLLECTION_NAME,
    data: [embedding],
    limit: limit + 1, // +1 to account for self-match
    filter,
    output_fields: ['ticket_id', 'issue_number', 'issue_title', 'repo_full_name'],
  });

  // 4. Filter and map results (exclude self and below threshold)
  return searchResults.results
    .filter(point => {
      const ticketIdValue = point.ticket_id as string;
      const score = point.score ?? 0;
      return ticketIdValue !== currentTicketId && score >= threshold;
    })
    .map(point => ({
      ticketId: point.ticket_id as string,
      issueNumber: point.issue_number as number,
      issueTitle: point.issue_title as string,
      similarity: point.score ?? 0,
      repoFullName: point.repo_full_name as string,
    }))
    .slice(0, limit);
}

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: CheckDuplicatesRequest = await req.json();
    const { ticketId, threshold = SIMILARITY_THRESHOLD, limit = SEARCH_LIMIT } = body;

    // Validate payload
    if (!ticketId) {
      return NextResponse.json({ error: 'Missing required field: ticketId' }, { status: 400 });
    }

    logExceptInTest('[check-duplicates] Checking for duplicates', {
      ticketId,
      threshold,
      limit,
    });

    // Get ticket from database
    const ticket = await getTriageTicketById(ticketId);

    if (!ticket) {
      logExceptInTest('[check-duplicates] Ticket not found', { ticketId });
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const organizationId = ticket.owned_by_organization_id || ticket.owned_by_user_id || '';

    // Generate and store embedding if not exists
    // Note: qdrant_point_id field is reused for Milvus point ID
    if (!ticket.qdrant_point_id) {
      const pointId = await generateAndStoreEmbedding(
        ticketId,
        organizationId,
        ticket.repo_full_name,
        ticket.issue_number,
        ticket.issue_title,
        ticket.issue_body
      );

      // Update ticket with point ID
      await updateTriageTicketStatus(ticket.id, ticket.status, {
        qdrantPointId: pointId,
      });
    }

    // Find similar tickets
    const similarTickets = await findSimilarTickets(
      ticketId,
      ticket.issue_title,
      ticket.issue_body,
      organizationId,
      ticket.repo_full_name,
      threshold,
      limit
    );

    logExceptInTest('[check-duplicates] Found similar tickets', {
      ticketId,
      count: similarTickets.length,
      topSimilarity: similarTickets[0]?.similarity || 0,
    });

    // Return candidates to the worker — it applies LLM reasoning to decide
    const response: CheckDuplicatesResponse = { similarTickets };

    return NextResponse.json(response);
  } catch (error) {
    errorExceptInTest('[check-duplicates] Error checking duplicates:', error);
    captureException(error, {
      tags: { source: 'check-duplicates-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to check duplicates',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
