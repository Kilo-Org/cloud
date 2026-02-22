# Auto-Analyze Security Findings

## Overview
Enable the security agent to automatically start analyzing security findings without requiring users to manually trigger them. This adds settings that allow users to:
1. Turn on/off auto-analyze (on by default)
2. Configure the minimum severity level for auto-analysis (default: all severities, but can be set to critical only, high and above, etc.)

## Feasibility: 🟢 HIGH
The existing codebase already has nearly all the building blocks — this is largely a wiring exercise, not a greenfield build.

## What's Already There
- **Single ingestion point** — `upsertSecurityFinding()` is the one place findings land during sync, making it easy to hook into
- **Full analysis pipeline** — `startSecurityAnalysis()` handles the end-to-end analysis workflow

## Implementation Plan

### 1. Settings Schema
- Add `autoAnalyzeEnabled` (boolean, default: `true`) to security settings
- Add `autoAnalyzeSeverityThreshold` (enum: `all` | `critical` | `high` | `medium` | `low`, default: `all`) to security settings
- These settings should be configurable per-organization

### 2. Auto-Analyze Trigger
- Hook into `upsertSecurityFinding()` to check if auto-analyze is enabled
- When a new finding is upserted and auto-analyze is enabled:
  - Check the finding's severity against the configured threshold
  - If it meets or exceeds the threshold, automatically call `startSecurityAnalysis()` for that finding
- Ensure idempotency — don't re-trigger analysis for findings that have already been analyzed

### 3. Severity Filtering Logic
- `all` — analyze all findings regardless of severity
- `critical` — only analyze critical findings
- `high` — analyze high and critical findings
- `medium` — analyze medium, high, and critical findings
- `low` — analyze low, medium, high, and critical findings

### 4. Rate Limiting / Throttling
- Consider adding rate limiting to prevent overwhelming the analysis pipeline during large syncs
- Batch or queue auto-triggered analyses to avoid thundering herd issues

### 5. Observability
- Log when auto-analysis is triggered vs skipped (with reason)
- Track auto-triggered vs manually-triggered analyses for metrics

### 6. User Experience
- Add UI controls in security settings for toggling auto-analyze and setting severity threshold
- Show indicator on findings that were auto-analyzed vs manually triggered

## Open Questions
- Should there be a per-repo override for the org-level setting?
- What rate limiting strategy makes sense for large orgs with many findings?
- Should auto-analysis be paused during initial onboarding sync to avoid noise?
