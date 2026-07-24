# Blueprints

## Initialization

`/init-project` asks focused questions and records answers only in `.autopilot/init/blueprint.json`. Deterministic scripts render the modular project files, create Blueprint v1, store project memory, validate the plan, commit a baseline, and remove the initialization draft.

The blueprint records product outcome, users, scope, languages, architecture decisions, rejected alternatives, dependencies, generated components, environment-variable names, credentials metadata, tools, MCP descriptors, gates, budgets, roadmap, dependency-ordered tasks, and Git commit policy. Secret values never belong in it.

Schema 6 supports either one fixed `git.commit_prefix` or a compact `git.commit_prefixes` map covering every task ID. Mapped values use `feat|fix|refactor|test|docs|chore|ci|build|security` with an optional lowercase scope. The mapping is compiled into protected controller configuration, not the queue or worker context. Schema-5 fixed-prefix blueprints remain supported unchanged.

Changing only the commit policy after initialization is a nonbreaking Category-A blueprint revision: it creates a new Blueprint version without inventing an application task. Completed tasks keep their original mapping, schema versions never move backward, and only future commits use the revised policy.

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
