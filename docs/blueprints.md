# Blueprints

## Initialization

`/init-project` asks focused questions and records answers only in `.autopilot/init/blueprint.json`. Deterministic scripts render the modular project files, create Blueprint v1, store project memory, validate the plan, commit a baseline, and remove the initialization draft.

The blueprint records product outcome, users, scope, languages, architecture decisions, rejected alternatives, dependencies, generated components, environment-variable names, credentials metadata, tools, MCP descriptors, gates, budgets, roadmap, and dependency-ordered tasks. Secret values never belong in it.

## Evolution after initialization

The blueprint is versioned source of truth, not a permanently frozen document.

`/evolve-project` compares a targeted request with the active contract and classifies it:

- Category A: documentation or metadata; update contract metadata.
- Category B: non-breaking feature; add roadmap and implementation tasks while preserving architecture.
- Category C: language, provider, integration, database, auth, communication, infrastructure, or architectural change; create a blueprint version and migration plan.

The delta questionnaire asks what changed, why, compatibility behavior, migration expectations, and only the affected architectural decisions. It does not repeat the original interview.

## Migration evidence

A Category C proposal records impacted and unaffected areas, file/module expectations, database and environment changes, tests, risk, rollback, compatibility, additions, replacements, and removals. The approval token binds the exact candidate blueprint, baseline, generated preview, and plan.

Applying a proposal updates generated control/project files and appends migration tasks. It does not implement or delete application behavior during planning. Workers later execute the approved tasks through the normal review and gate loop.

## Legacy projects

The evolution skill can reconstruct Blueprint v1 metadata from an older modular project without rewriting generated or application files. It asks only for consequential facts that cannot be recovered. This blueprint adoption is separate from Control Plane framework adoption.
