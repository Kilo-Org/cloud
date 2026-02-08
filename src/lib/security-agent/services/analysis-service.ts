/**
 * Security Analysis Service
 *
 * Orchestrates LLM-powered analysis of security findings using a three-tier approach:
 * - Tier 1: Quick triage via direct LLM call (always runs first)
 * - Tier 2: Sandbox analysis via cloud agent (only if needed or forced)
 * - Tier 3: Structured extraction via direct LLM call (extracts fields from raw markdown)
 *
 * Uses an async pattern - starts the session and processes results in background.
 */

import 'server-only';
import { createCloudAgentClient } from '@/lib/cloud-agent/cloud-agent-client';
import { generateApiToken } from '@/lib/tokens';
import { getSecurityFindingById } from '../db/security-findings';
import { updateAnalysisStatus } from '../db/security-analysis';
import type { SecurityFindingAnalysis, SecurityReviewOwner } from '../core/types';
import type { User, SecurityFinding } from '@/db/schema';
import type { StreamEvent, SystemKilocodeEvent } from '@/components/cloud-agent/types';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { cliSessions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getBlobContent } from '@/lib/r2/cli-sessions';
import { triageSecurityFinding } from './triage-service';
import { extractSandboxAnalysis } from './extraction-service';
import { maybeAutoDismissAnalysis } from './auto-dismiss-service';

const ANALYSIS_PROMPT_TEMPLATE = `You are a security analyst reviewing a dependency vulnerability alert for a codebase.

## Vulnerability Details
- **Package**: {{packageName}} ({{packageEcosystem}})
- **Severity**: {{severity}}
- **Dependency Scope**: {{dependencyScope}}
- **CVE**: {{cveId}}
- **GHSA**: {{ghsaId}}
- **Title**: {{title}}
- **Description**: {{description}}
- **Vulnerable Versions**: {{vulnerableVersionRange}}
- **Patched Version**: {{patchedVersion}}
- **Manifest Path**: {{manifestPath}}

## Your Task

1. **Search the codebase** for usages of the \`{{packageName}}\` package:
   - Look for import/require statements
   - Check how the package is used (which functions/methods are called)
   - Identify if the vulnerable code paths mentioned in the CVE are actually used

2. **Analyze relevance**:
   - Is this package actually used in production code (not just dev dependencies)?
   - Note: This package is listed as a **{{dependencyScope}}** dependency
   - Are the vulnerable functions/methods being called?
   - Is user input ever passed to the vulnerable code paths?

3. **Determine exploitability**:
   - Can an attacker actually trigger the vulnerability given how the package is used?
   - Are there mitigating factors (input validation, sandboxing, etc.)?
   - What would an attacker need to do to exploit this?

4. **Provide recommendations**:
   - What is the suggested fix (e.g., upgrade to patched version)?
   - Are there any workarounds if upgrading is not immediately possible?

## Output Format

Provide a detailed markdown analysis covering:
- **Usage Locations**: List all files where the package is imported/used with line numbers (e.g., "src/utils/helpers.ts:42")
- **Exploitability Assessment**: Whether the vulnerability can be triggered given how the package is used (exploitable/not exploitable/unknown)
- **Reasoning**: Detailed explanation of why this is/isn't exploitable
- **Suggested Fix**: Specific fix recommendation (e.g., upgrade to version X.Y.Z)
- **Summary**: Brief 1-2 sentence summary of findings
`;

/**
 * Build the analysis prompt for a finding
 */
function buildAnalysisPrompt(finding: SecurityFinding): string {
  const replacements: Record<string, string> = {
    packageName: finding.package_name,
    packageEcosystem: finding.package_ecosystem,
    severity: finding.severity,
    dependencyScope: finding.dependency_scope || 'runtime',
    cveId: finding.cve_id || 'N/A',
    ghsaId: finding.ghsa_id || 'N/A',
    title: finding.title,
    description: finding.description || 'No description available',
    vulnerableVersionRange: finding.vulnerable_version_range || 'Unknown',
    patchedVersion: finding.patched_version || 'No patch available',
    manifestPath: finding.manifest_path || 'Unknown',
  };
  return ANALYSIS_PROMPT_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] ?? '');
}

/**
 * Check if this is a session_created event
 */
function isSessionCreatedEvent(event: SystemKilocodeEvent): boolean {
  return event.payload.event === 'session_created';
}

/**
 * Raw message format from CLI sessions stored in R2.
 * CLI messages use a different format than CloudMessage:
 * - type: 'say' | 'ask' (not 'user' | 'assistant' | 'system')
 * - say: 'user_feedback' for user messages, other values for assistant
 * - ask: present for assistant messages asking for input
 */
type RawCliMessage = {
  ts?: number;
  timestamp?: string;
  type?: string;
  say?: string;
  ask?: string;
  text?: string;
  content?: string;
};

/**
 * Extract text content from a raw CLI message.
 */
function getCliMessageContent(msg: RawCliMessage): string | null {
  const content = msg.text || msg.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  return trimmed ? trimmed : null;
}

/**
 * Fetch the last assistant message from a CLI session's ui_messages blob.
 * This is the final analysis result that we want to store.
 */
async function fetchLastAssistantMessage(cliSessionId: string): Promise<string | null> {
  try {
    // Get the session to find the ui_messages blob URL
    const [session] = await db
      .select({ ui_messages_blob_url: cliSessions.ui_messages_blob_url })
      .from(cliSessions)
      .where(eq(cliSessions.session_id, cliSessionId))
      .limit(1);

    if (!session?.ui_messages_blob_url) {
      console.log('[Security Analysis] No ui_messages blob URL found for session:', cliSessionId);
      return null;
    }

    // Fetch the messages from R2
    const messages = (await getBlobContent(session.ui_messages_blob_url)) as RawCliMessage[] | null;

    if (!messages || messages.length === 0) {
      console.log('[Security Analysis] No messages found in session:', cliSessionId);
      return null;
    }

    console.log('[Security Analysis] Fetched messages from R2:', {
      cliSessionId,
      messageCount: messages.length,
      lastFewTypes: messages.slice(-5).map(m => ({ type: m.type, say: m.say, ask: m.ask })),
    });

    // Prefer completion_result as the final analysis output.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'say' && msg.say === 'completion_result') {
        const content = getCliMessageContent(msg);
        if (content) {
          console.log('[Security Analysis] Found completion_result message:', {
            cliSessionId,
            messageIndex: i,
            contentLength: content.length,
            contentPreview: content.substring(0, 200),
          });
          return content;
        }
      }
    }

    // Fall back to the last assistant text message.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'say' && msg.say === 'text') {
        const content = getCliMessageContent(msg);
        if (content) {
          console.log('[Security Analysis] Found last text message:', {
            cliSessionId,
            messageIndex: i,
            contentLength: content.length,
            contentPreview: content.substring(0, 200),
          });
          return content;
        }
      }
    }

    // Last resort: any say message that isn't user feedback.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'say' && msg.say !== 'user_feedback') {
        const content = getCliMessageContent(msg);
        if (content) {
          console.log('[Security Analysis] Found fallback say message:', {
            cliSessionId,
            messageIndex: i,
            messageSay: msg.say,
            contentLength: content.length,
            contentPreview: content.substring(0, 200),
          });
          return content;
        }
      }
    }

    console.log('[Security Analysis] No suitable analysis message found in session:', cliSessionId);
    return null;
  } catch (error) {
    console.error('[Security Analysis] Error fetching last assistant message:', error);
    captureException(error, {
      tags: { operation: 'fetchLastAssistantMessage' },
      extra: { cliSessionId },
    });
    return null;
  }
}

/**
 * Finalize sandbox analysis by extracting structured fields from raw markdown.
 *
 * Tier 3: Uses direct LLM call to extract structured fields from the raw analysis.
 * Preserves existing triage data.
 *
 * After storing the analysis, attempts auto-dismiss if:
 * - Auto-dismiss is enabled in config
 * - sandboxAnalysis.isExploitable === false
 */
async function finalizeAnalysis(
  findingId: string,
  rawMarkdown: string,
  model: string,
  owner: SecurityReviewOwner,
  userId: string,
  authToken: string,
  organizationId?: string
): Promise<void> {
  if (!rawMarkdown.trim()) {
    await updateAnalysisStatus(findingId, 'failed', {
      error: 'No response received from analysis agent',
    });
    return;
  }

  // Get existing analysis to preserve triage data
  const finding = await getSecurityFindingById(findingId);
  if (!finding) {
    await updateAnalysisStatus(findingId, 'failed', {
      error: 'Finding not found during finalization',
    });
    return;
  }

  const existingAnalysis = finding.analysis;

  // =========================================================================
  // Tier 3: Extract structured fields from raw markdown
  // =========================================================================
  console.log('[Security Analysis] Starting Tier 3 extraction:', { findingId });

  const sandboxAnalysis = await extractSandboxAnalysis(
    finding,
    rawMarkdown,
    authToken,
    model,
    organizationId
  );

  console.log('[Security Analysis] Extraction complete:', {
    findingId,
    isExploitable: sandboxAnalysis.isExploitable,
    usageLocationsCount: sandboxAnalysis.usageLocations.length,
  });

  const analysis: SecurityFindingAnalysis = {
    triage: existingAnalysis?.triage,
    sandboxAnalysis,
    analyzedAt: new Date().toISOString(),
    modelUsed: model,
    triggeredByUserId: existingAnalysis?.triggeredByUserId,
  };

  await updateAnalysisStatus(findingId, 'completed', { analysis });

  // Attempt auto-dismiss after sandbox analysis if isExploitable === false
  if (sandboxAnalysis.isExploitable === false) {
    void maybeAutoDismissAnalysis(findingId, analysis, owner, userId).catch((error: unknown) => {
      console.error('[Security Analysis] Auto-dismiss after sandbox error:', error);
      captureException(error, {
        tags: { operation: 'maybeAutoDismissAnalysis' },
        extra: { findingId },
      });
    });
  }
}

/**
 * Process the cloud agent session stream in the background.
 * Runs after startSecurityAnalysis returns.
 *
 * Strategy:
 * 1. Capture the CLI session ID from the session_created event
 * 2. Wait for the complete event
 * 3. Fetch the last assistant message from the session's ui_messages blob
 * 4. Run Tier 3 extraction to get structured fields
 * 5. Attempt auto-dismiss if isExploitable === false
 */
async function processAnalysisStream(
  findingId: string,
  streamGenerator: AsyncGenerator<StreamEvent, void, unknown>,
  model: string,
  owner: SecurityReviewOwner,
  userId: string,
  authToken: string,
  organizationId?: string
): Promise<void> {
  let cloudAgentSessionId: string | null = null;
  let cliSessionId: string | null = null;

  try {
    for await (const event of streamGenerator) {
      switch (event.streamEventType) {
        case 'status':
          if (event.sessionId) {
            // Only persist sessionId / running transition when it first becomes available.
            // Cloud-agent emits multiple status events; avoid unnecessary writes.
            if (cloudAgentSessionId !== event.sessionId) {
              cloudAgentSessionId = event.sessionId;
              await updateAnalysisStatus(findingId, 'running', { sessionId: cloudAgentSessionId });
            }
          }
          break;

        case 'kilocode': {
          // Check for session_created event to capture CLI session ID
          if (isSessionCreatedEvent(event)) {
            const payloadSessionId = event.payload.sessionId;
            if (typeof payloadSessionId === 'string') {
              cliSessionId = payloadSessionId;
              console.log('[Security Analysis] Session created:', {
                findingId,
                cloudAgentSessionId,
                cliSessionId,
              });
              // Update the finding with the CLI session ID for linking
              await updateAnalysisStatus(findingId, 'running', {
                sessionId: cloudAgentSessionId ?? undefined,
                cliSessionId,
              });
            }
          }
          break;
        }

        case 'error':
          await updateAnalysisStatus(findingId, 'failed', {
            error: event.error || 'Unknown error during analysis',
          });
          return;

        case 'complete': {
          // Stream completed - fetch the last message from the session
          console.log('[Security Analysis] Stream complete, fetching last message:', {
            findingId,
            cliSessionId,
          });

          if (!cliSessionId) {
            await updateAnalysisStatus(findingId, 'failed', {
              error: 'Analysis completed but no CLI session ID was captured',
            });
            return;
          }

          // Wait/retry for session ui_messages to be available in DB/R2.
          // R2 writes can lag behind the stream completion event.
          const maxAttempts = 5;
          let delayMs = 1500;
          let lastMessage: string | null = null;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            lastMessage = await fetchLastAssistantMessage(cliSessionId);
            if (lastMessage) break;
            delayMs = Math.min(delayMs * 2, 15_000);
          }

          if (lastMessage) {
            await finalizeAnalysis(
              findingId,
              lastMessage,
              model,
              owner,
              userId,
              authToken,
              organizationId
            );
          } else {
            await updateAnalysisStatus(findingId, 'failed', {
              error: 'Analysis completed but result was not available (no completion_result found)',
            });
          }
          return;
        }

        case 'interrupted':
          await updateAnalysisStatus(findingId, 'failed', {
            error: `Analysis interrupted: ${event.reason}`,
          });
          return;
      }
    }

    // Stream ended without explicit completion event
    console.log('[Security Analysis] Stream ended without complete event:', {
      findingId,
      cliSessionId,
    });

    if (cliSessionId) {
      // Try to fetch the last message anyway
      await new Promise(resolve => setTimeout(resolve, 2000));
      const lastMessage = await fetchLastAssistantMessage(cliSessionId);
      if (lastMessage) {
        await finalizeAnalysis(
          findingId,
          lastMessage,
          model,
          owner,
          userId,
          authToken,
          organizationId
        );
        return;
      }
    }

    await updateAnalysisStatus(findingId, 'failed', {
      error: 'Analysis stream ended without completion',
    });
  } catch (error) {
    await updateAnalysisStatus(findingId, 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error, {
      tags: { operation: 'processAnalysisStream' },
      extra: { findingId, cloudAgentSessionId, cliSessionId },
    });
  }
}

/**
 * Start analysis for a security finding using three-tier approach.
 *
 * Tier 1 (Quick Triage): Always runs first. Direct LLM call to analyze metadata.
 * Tier 2 (Sandbox Analysis): Only runs if triage says it's needed OR forceSandbox is true.
 * Tier 3 (Structured Extraction): Extracts structured fields from raw markdown output.
 *
 * @param params.findingId - The security finding to analyze
 * @param params.user - The user initiating the analysis
 * @param params.githubRepo - The GitHub repository (owner/repo format)
 * @param params.githubToken - Optional GitHub token for private repos
 * @param params.model - Model to use for analysis
 * @param params.forceSandbox - Skip triage decision and always run sandbox analysis
 * @param params.organizationId - Optional organization ID (for org-level analysis)
 */
export async function startSecurityAnalysis(params: {
  findingId: string;
  user: User;
  githubRepo: string;
  githubToken?: string;
  model?: string;
  forceSandbox?: boolean;
  organizationId?: string;
}): Promise<{ started: boolean; error?: string; triageOnly?: boolean }> {
  const {
    findingId,
    user,
    githubRepo,
    githubToken,
    model = 'anthropic/claude-sonnet-4',
    forceSandbox = false,
    organizationId,
  } = params;

  // Get the finding
  const finding = await getSecurityFindingById(findingId);
  if (!finding) {
    return { started: false, error: `Finding not found: ${findingId}` };
  }

  // Check if already running
  if (finding.analysis_status === 'running') {
    return { started: false, error: 'Analysis already in progress' };
  }

  // Mark as pending
  await updateAnalysisStatus(findingId, 'pending');

  try {
    // Generate auth token for LLM calls
    const authToken = generateApiToken(user);

    // =========================================================================
    // Tier 1: Quick Triage (always runs)
    // =========================================================================
    console.log('[Security Analysis] Starting Tier 1 triage:', { findingId, model });

    const triage = await triageSecurityFinding(finding, authToken, model, organizationId);

    console.log('[Security Analysis] Triage complete:', {
      findingId,
      needsSandboxAnalysis: triage.needsSandboxAnalysis,
      needsSandboxReasoning: triage.needsSandboxReasoning,
      suggestedAction: triage.suggestedAction,
      confidence: triage.confidence,
      forceSandbox,
    });

    // Decide whether to run sandbox analysis
    const runSandbox = forceSandbox || triage.needsSandboxAnalysis;

    if (!runSandbox) {
      // =========================================================================
      // Triage-only: Save result and potentially auto-dismiss
      // =========================================================================
      console.log('[Security Analysis] Triage-only completion:', { findingId });

      const analysis: SecurityFindingAnalysis = {
        triage,
        // No sandboxAnalysis - triage determined sandbox not needed
        analyzedAt: new Date().toISOString(),
        modelUsed: model,
        triggeredByUserId: user.id,
      };

      await updateAnalysisStatus(findingId, 'completed', { analysis });

      // Attempt auto-dismiss if configured (off by default)
      const owner: SecurityReviewOwner = organizationId ? { organizationId } : { userId: user.id };

      // Run auto-dismiss in background (don't block response)
      void maybeAutoDismissAnalysis(findingId, analysis, owner, user.id).catch((error: unknown) => {
        console.error('[Security Analysis] Auto-dismiss error:', error);
        captureException(error, {
          tags: { operation: 'maybeAutoDismissAnalysis' },
          extra: { findingId },
        });
      });

      return { started: true, triageOnly: true };
    }

    // =========================================================================
    // Tier 2: Sandbox Analysis (cloud agent)
    // =========================================================================
    console.log('[Security Analysis] Starting Tier 2 sandbox analysis:', { findingId });

    // Save triage first, then start sandbox
    const partialAnalysis: SecurityFindingAnalysis = {
      triage,
      analyzedAt: new Date().toISOString(),
      modelUsed: model,
      triggeredByUserId: user.id,
    };
    await updateAnalysisStatus(findingId, 'pending', { analysis: partialAnalysis });

    // Build the analysis prompt
    const prompt = buildAnalysisPrompt(finding);

    // Create cloud agent client
    const client = createCloudAgentClient(authToken);

    console.log('[Security Analysis] Starting cloud agent:', { findingId });

    // Start the session stream (no MCP - Tier 3 extraction handles structured output)
    const streamGenerator = client.initiateSessionStream({
      githubRepo,
      githubToken,
      kilocodeOrganizationId: organizationId,
      prompt,
      mode: 'code', // Use code mode so agent can search files
      model,
    });

    // Build owner for auto-dismiss context
    const owner: SecurityReviewOwner = organizationId ? { organizationId } : { userId: user.id };

    // Process stream in background (don't await)
    // Using void to explicitly ignore the promise
    void processAnalysisStream(
      findingId,
      streamGenerator,
      model,
      owner,
      user.id,
      authToken,
      organizationId
    );

    return { started: true, triageOnly: false };
  } catch (error) {
    await updateAnalysisStatus(findingId, 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error, {
      tags: { operation: 'startSecurityAnalysis' },
      extra: { findingId, githubRepo },
    });
    return { started: false, error: error instanceof Error ? error.message : String(error) };
  }
}
