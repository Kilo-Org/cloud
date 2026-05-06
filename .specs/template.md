# [Feature Name]

## Role of This Document

This spec defines [feature] business rules and invariants: valid states, ownership boundaries, correctness properties,
and user-facing behavior. It is the source of truth for _what_ the system must guarantee, not _how_ to implement it.
Handler names, column layouts, conflict-resolution strategies, and other implementation choices belong in plans and code.

## Status

Draft -- created YYYY-MM-DD.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT
RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174]
when, and only when, they appear in all capitals, as shown here.

## Definitions

- **Term**: Domain-specific term definition used throughout this spec.

## Overview

Concise narrative (1-2 paragraphs) describing the feature from user and system perspectives. Cover what the feature
does, audience, and high-level lifecycle. Avoid implementation details.

## Rules

### [Section Name]

1. System MUST ...
2. System MUST NOT ...

## Error Handling

1. When [error condition], system MUST [behavior].

## Not Yet Implemented

Intended SHOULD rules not yet enforced in the current codebase:

1. System SHOULD ... (Currently ...)

## Changelog

### YYYY-MM-DD -- Initial spec

- Created from [source].
