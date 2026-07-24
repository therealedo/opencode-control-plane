# Maintenance and releases

## Source checks

`npm run validate` checks skill frontmatter, release identity, required assets, JSON, role permissions, tool grants, JavaScript syntax, the beginner README contract, a fresh scaffold, and project validation.

`npm test` runs scaffold, renderer, evolution, policy-boundary, process, controller recovery, evaluator, dashboard, installer, and upgrade tests. `npm run check` runs validation and tests together.

## Release procedure

1. Make the framework change and focused tests.
2. Keep model-facing skills and `AGENTS.md` concise; move deterministic behavior into scripts.
3. Run `node scripts/evaluate.mjs --simulate` so the full corpus, budget, resume, and reporting path is exercised without a model.
4. Bump the same semantic version in `package.json` and `.agents/skills/init-project/assets/control-plane-release.json`.
5. Run `npm run check`.
6. Run `npm run upgrade -- --local --all-projects` against a staging home and disposable initialized projects.
7. Commit, create the matching `vMAJOR.MINOR.PATCH` tag, and publish a stable GitHub Release at `https://github.com/therealedo/opencode-control-plane.git`.

For changes to prompts, generated project references, packet assembly, or tool schemas, also update the fixed footprint fixture and token-efficiency test. Compare like-for-like phases and report framework-owned bytes separately from provider-reported tokens, reasoning, cache reads, cost, and acceptance quality. Never advertise a byte reduction as a guaranteed billing reduction.

Live evaluation is optional release evidence, never a release-script side effect. Use a copied local profile, one fixed model/variant and OpenCode version, explicit spend confirmation, and an evaluator-owned temporary run. Publish the complete failure-visible report and configuration hash; do not rank incomplete telemetry or combine different model/provider profiles.

## Global upgrade

The normal `npm run upgrade` path verifies a clean Git clone and the exact public origin, performs a fast-forward-only pull, validates source, and invokes installer upgrade mode. Installer upgrade mode compares every destination with its prior whole-tree hash. Missing or edited outputs abort all writes. Staging and swaps are transactional.

The old schema-1 global install manifest is accepted and migrated to schema 2. The previous `--full` selection is preserved.

The installer also owns one user-scoped `control-plane` launcher. It uses the exact Node executable selected during installation, preserves the chosen command directory on later upgrades, refuses an unowned collision, and reports instead of silently editing PATH.

The fleet TUI checks only stable GitHub Releases with exact `vMAJOR.MINOR.PATCH` tags. Remote installation uses a temporary exact-tag clone, validates matching package/release identity, and then invokes the release's local upgrade path. Offline checks are nonfatal. Local maintainers can bump the version and use the same TUI update action or `npm run upgrade -- --local --all-projects`.

## Project upgrade

`.autopilot/control-plane.json` records the installed release, managed modes/hashes, and migration history. Project upgrade:

1. verifies the standalone clean Git root and controller boundary;
2. verifies every previous ownership hash;
3. builds candidates from the new release;
4. preserves current dynamic role grants and user `.ignore` lines;
5. swaps managed files with temporary rollback copies;
6. checks role grants and strict project validation;
7. stages only exact managed paths and commits them locally;
8. removes temporary copies and verifies a clean worktree.

Removed release paths are retained instead of silently deleted. Configuration/state schema changes must be implemented as explicit ordered migrations; they must never be copied from the template.

An older unfinished interview has one narrower exception to the clean-worktree rule. Immediately before finalization, its globally installed closeout script may refresh only manifest-owned framework files when the controller is idle, the queue is still initializing, no blueprint lifecycle exists, and every old ownership hash matches. The draft blueprint is compared byte-for-byte before and after, no upgrade commit is created, and the normal initialization baseline captures the refreshed framework. Any drift or partial lifecycle fails closed.

`upgrade-all-projects.mjs` never passes `--adopt`. Versioned projects update independently; running workers drain cooperatively and resume only if they were live before the update. Missing, legacy, dirty, drifted, or interrupted projects remain named in the result. A rerun is the recovery mechanism for partial fleet completion.

## Compatibility namespaces

The public product name is OpenCode Control Plane. Internal `.autopilot/`, `autopilot.mjs`, `autopilot_*` tools, and `/autopilot-*` compatibility commands remain stable to avoid destructive migrations.
