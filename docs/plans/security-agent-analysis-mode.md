# Security Agent: Analysis Mode Setting

## Overview

Add an `analysis_mode` setting to the Security Agent configuration that lets users control the depth of vulnerability analysis. Currently the pipeline is fully automatic (triage → optional sandbox). This plan introduces three modes:

- **Auto** (default, current behavior): Triage runs first; sandbox analysis runs only if triage determines it's needed.
- **Shallow** (triage only): Only the Tier 1 LLM triage step runs. No sandbox analysis is performed regardless of triage output.
- **Deep** (force sandbox): Triage is skipped (or its result ignored) and sandbox analysis is always performed.

## Key Discovery: No Database Migration Needed

The `analysis_mode` field fits inside the existing JSONB `config` column on `agent_configs`. The existing default-merge pattern in `getSecurityAgentConfig()` means all existing users automatically get `'auto'` mode — zero migration needed.

## Implementation Plan

### 1. Update Config Schema & Defaults

- Add `analysis_mode: 'auto' | 'shallow' | 'deep'` to the Security Agent config type definition.
- Set the default to `'auto'` in the default config object so existing users get current behavior automatically.

### 2. Update Analysis Pipeline

- In the analysis orchestration logic, read `analysis_mode` from the resolved config.
- **`auto`**: Current behavior — run triage, then conditionally run sandbox based on triage result.
- **`shallow`**: Run triage only. Skip sandbox analysis entirely. Use triage result as the final analysis.
- **`deep`**: Skip triage (or ignore its recommendation). Always run sandbox analysis.

### 3. Update API / Settings UI

- Expose `analysis_mode` in the Security Agent settings API endpoint.
- Add UI control (dropdown or radio group) in the Security Agent settings page with the three options.
- Include help text explaining each mode.

### 4. Testing

- Unit tests for each mode ensuring correct pipeline behavior.
- Integration test confirming default config merging works (existing users get `'auto'`).
- Test that `shallow` mode never triggers sandbox.
- Test that `deep` mode always triggers sandbox.

### 5. Documentation

- Update any user-facing docs to describe the new setting.
- Add changelog entry.

## Rollout

- Ship behind existing Security Agent feature flag.
- Default to `'auto'` so no behavioral change for existing users.
- Monitor sandbox usage metrics to understand adoption of each mode.
