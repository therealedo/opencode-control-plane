---
name: evolve-project
description: Version and safely evolve an initialized OpenCode blueprint after requirement, feature, language, provider, integration, or architecture changes; also compare versions or plan migrations.
---

# Evolve an initialized project

The blueprint is a versioned, evolving contract. Preserve versions/evidence; never rebuild or edit application code while planning.

## Route

- Before initialization: edit `.autopilot/init/blueprint.json`; create no version.
- Approved work with no contract change: use the normal controller.
- Post-init metadata, feature, or architecture delta: use this workflow.
- Breaking architecture: require a new version, migration plan, and approval.

Use the project's `.autopilot/bin/evolve-blueprint.mjs`, or this skill's copy for an older project. First reach a maintenance boundary with no live controller or active task; the dashboard's **Change product blueprint** action does this.

If status is `legacy_adoption_required`, run `adopt-prepare --root <project-root> --json`; reconstruct Blueprint v1 from project files, queue, receipts, config, environment-name examples, and code. Ask only unrecoverable consequential facts. Run `adopt-plan --root <project-root> --json`; after approval use the returned token with `adopt-apply`, then commit. Adoption changes lifecycle metadata only—application/generated files and history stay byte-identical.

## Prepare the delta

Run `node .autopilot/bin/evolve-blueprint.mjs prepare --json`. Read current memory/blueprint and affected files only. Edit the reported candidate/request, copying the existing contract forward.

Classify:

- A: documentation/metadata only;
- B: feature behavior preserving architecture; append implementation tasks;
- C: language, provider, integration, database, auth, communications, infrastructure, or architecture; append migration tasks.

Never alter/remove completed task IDs; supersede them with new tasks.

Run `questions --json`, ask only its unanswered delta questions, and record `.autopilot/evolution/answers.json`. Resolve replacement/coexistence, compatibility, migration, and fallback only where implicated. Never repeat initialization discovery.

## Plan and approve

Run `plan --json`. It stages `blueprints/vN/` with the candidate, request/answers, impact, migration plan, exact generated baselines/staged copies, and a digest-bound approval token. Present classification, compatibility, affected/unaffected areas, risk, removals, environment changes, tests, rollback, and tasks. Do not apply.

For comparison only, use `compare --from v1 --to v2 --json` or `--to draft`.

After explicit approval run:

```text
node .autopilot/bin/evolve-blueprint.mjs apply --version N --approve TOKEN --json
```

Apply fails on changed controller state, active blueprint, generated files, or plan. It merges queue state and generated control files only—never application code. Commit activation, provision credentials, preflight, and resume. High-risk tasks retain their execution approval boundary.

Never delete a project, silently remove behavior, rewrite accepted receipts, or perform destructive application changes during activation.
