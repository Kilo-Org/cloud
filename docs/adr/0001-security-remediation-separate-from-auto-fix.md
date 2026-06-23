# ADR 0001: Keep Security Remediation Separate From Legacy Auto Fix

## Status

Accepted

## Context

Security Agent needs an Auto Remediation feature that can create pull requests for eligible Security Findings after sandbox analysis determines that code remediation is the right next step.

The repository already has an Auto Fix implementation, but that implementation is not trusted as a foundation for Security Agent remediation work. Reusing it would couple Security Agent to legacy Auto Fix tickets, prompts, states, and PR handling that do not match the Security Agent domain.

## Decision

Security Agent Auto Remediation will use Security Agent-owned remediation records instead of legacy Auto Fix tickets.

Security Remediation is the durable unit of work for a Security Finding. Remediation attempts track individual Cloud Agent sessions and pull request outcomes. The legacy Auto Fix tables and orchestration are not the source of truth for Security Agent remediation.

## Consequences

Security Agent can define remediation eligibility, state, audit, retry, cancellation, and UI behavior in its own domain language.

Cloud Agent remains responsible for performing the code changes and opening the pull request. Security Agent records and verifies the remediation outcome instead of delegating state ownership to legacy Auto Fix.

This adds new schema and orchestration code, but avoids building a security workflow on top of an implementation that is not actively trusted or developed.
