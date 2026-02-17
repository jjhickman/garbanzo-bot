# Garbanzo Product Roadmap
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


This roadmap describes the next major product milestones for Garbanzo.

It focuses on user-facing outcomes, platform trust, and sustainable operations.

## Direction

Garbanzo is an AI chat operations platform for communities and small teams.

Priority order:

1. Improve reliability and operator confidence.
2. Improve member-facing workflows and usability.
3. Expand platform support through stable adapter boundaries.
4. Add advanced governance features where demand is proven.

## Current Focus (Near Term)

### 1) Product Clarity and Adoption

- Improve onboarding clarity in README and docs.
- Keep setup paths simple for Docker-first deployments.
- Make supported-vs-experimental platform posture explicit.

### 2) Operational Reliability

- Keep health/readiness and backup verification as first-class release gates.
- Tighten release and rollback runbooks.
- Keep default deployments version-pinned and reproducible.

### 3) Member Experience

- Continue improving community workflows (summaries, recommendations, event planning, moderation alerts).
- Keep chat updates concise and useful.
- Avoid noisy automations that reduce trust.

## Planned Milestones

## Milestone A: Narrative and Docs Alignment

- Align README, website, and docs around a single product story.
- Clarify who Garbanzo is for and what it does not try to be.
- Keep public docs reusable and free of internal-only business playbooks.

Done when:

- New users can understand value, deployment path, and support expectations quickly.

## Milestone B: Paid-Readiness Baseline

- Improve admin controls and usage visibility.
- Keep release communication policy member-safe by default.
- Ensure support and deployment workflows are documented and repeatable.

Done when:

- Multiple production users can operate with low manual intervention.

## Milestone C: Platform Expansion Quality

- Continue adapter architecture hardening.
- Improve Slack/Discord/Teams adapter parity where practical.
- Keep platform-specific behavior explicit and testable.

Done when:

- Cross-platform behavior is predictable for common command and routing paths.

## Milestone D: Advanced Governance (Demand-Gated)

- Expand governance controls only when real customer demand justifies it.
- Keep open-core usability strong while adding optional operational depth.

Done when:

- Governance additions have clear user demand and adoption evidence.

## Release and Deployment Principles

- Every release should be deployable and reversible quickly.
- Member-facing release notes should only include changes relevant to members.
- Internal/operator changes should remain internal unless a member-facing impact exists.
- Website changes should be deployed and verified as part of release completion.

## What We Avoid

- Shipping speculative features with no user pull.
- Over-expanding platform claims beyond tested capability.
- Sending release chatter to groups for internal-only engineering changes.
- Overcomplicated setup paths that increase maintenance burden.

## How to Track Progress

Primary indicators:

- Stable deploy and rollback execution.
- Active usage of member-facing features.
- Low operational incident volume.
- Clear onboarding and documentation feedback.

For release mechanics and command specifics, see `docs/RELEASES.md`.
