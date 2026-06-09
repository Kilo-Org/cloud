# Kilo Code Cloud

Kilo Code Cloud is the platform for hosted Kilo Code agents, integrations, and automation.

## Language

**Security Agent**:
The agent that syncs, analyses, and helps resolve repository security findings.
_Avoid_: Security Reviews

**Security Finding**:
A vulnerability item owned by a user or organization for a repository, usually synced from Dependabot.
_Avoid_: Security review, alert

**Auto Remediation**:
The Security Agent feature that automatically starts Security Remediations for eligible Security Findings.
_Avoid_: Auto Fix

**Security Remediation**:
A Security Agent-owned remediation task created from a Security Finding after analysis determines that a pull request is the right next step.
_Avoid_: Auto Fix ticket

**Security Remediation Attempt**:
A single attempt to remediate a Security Finding through Cloud Agent, including its session and pull request outcome.
_Avoid_: Auto Fix run

**Cloud Agent Write Identity**:
The identity Cloud Agent uses to push remediation branches and open pull requests for Security Remediations.
_Avoid_: Security Agent Bot
