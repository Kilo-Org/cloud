# [Feature Name]

## Role of This Document

This spec defines the business rules and invariants for [feature].
It is the source of truth for _what_ the system must guarantee —
valid states, ownership boundaries, correctness properties, and
user-facing behavior. It deliberately does not prescribe _how_ to
implement those guarantees: handler names, column layouts,
conflict-resolution strategies, and other implementation choices
belong in plan documents and code, not here.

## Status

Draft -- created YYYY-MM-DD.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **Term**: Definition of a domain-specific term used throughout
  this spec.

## Overview

A concise narrative (1-2 paragraphs) describing the feature from a
user and system perspective. Cover what the feature does, who it
serves, and the high-level lifecycle. Avoid implementation details.

## Rules

### [Section Name]

1. The system MUST ...
2. The system MUST NOT ...

## Error Handling

1. When [error condition], the system MUST [behavior].

## Not Yet Implemented

The following rules use SHOULD and reflect intended behavior that is
not yet enforced in the current codebase:

1. The system SHOULD ... (Currently ...)

## Changelog

### YYYY-MM-DD -- Initial spec

- Created from [source].
