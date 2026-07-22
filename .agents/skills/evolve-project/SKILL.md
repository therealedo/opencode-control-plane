---
name: evolve-project
description: Version and safely evolve an initialized OpenCode blueprint after requirement, feature, language, provider, integration, or architecture changes; also compare versions or plan migrations.
---

# Evolve an initialized project

The blueprint is an evolving contract. Preserve versions/evidence; never rebuild or edit application code during planning.

## 1. Route the request

- Before initialization: edit `.autopilot/init/blueprint.json`; create no version.
- Approved task with no contract change: use the normal controller.
- Post-init metadata, feature, or architecture delta: use this workflow.
- Breaking architecture: require a version, migration plan, and explicit approval.

Use `.autopilot/bin/evolve-blueprint.mjs` when present; for older projects use this skill's `bin/evolve-blueprint.mjs`. Confirm the Control Plane is at a maintenance boundary with no live controller or active task. The dashboard's **Change product blueprint** action reaches this boundary before opening the interview.

If status reports `legacy_adoption_required`, do a one-time non-rewriting adoption:

1. Run `adopt-prepare --root <project-root> --json`.
2. Reconstruct the reported Blueprint v1 draft from `.project/`, queue, receipts, config, environment-name examples, and code structure. Do not re-interview; ask only for consequential facts that cannot be recovered.
3. Run `adopt-plan --root <project-root> --json`; review v1, exact baseline, and normalization preview.
4. After approval run `adopt-apply --root <project-root> --approve TOKEN --json`, then commit.

Adoption writes lifecycle metadata only; generated/application files and task/receipt history stay byte-identical.

## 2. Prepare only the delta

Run `node .autopilot/bin/evolve-blueprint.mjs prepare --json`. Read current memory/blueprint and only affected files. Edit the reported candidate/request; copy the contract forward instead of restarting discovery.

Classify changes as:

- A: documentation/metadata only.
- B: feature behavior preserving architecture; append roadmap/implementation tasks.
- C: language, provider, integration, database, auth, communications, infrastructure, or architecture; append migration tasks.

Do not alter/remove completed task IDs; supersede through new tasks.

## 3. Ask targeted questions

Run `node .autopilot/bin/evolve-blueprint.mjs questions --json`. Ask only unanswered questions and record `.autopilot/evolution/answers.json`. Resolve replacement/coexistence, compatibility, data migration, and fallback only where implicated. Never repeat initialization discovery.

## 4. Stage and review

Run `node .autopilot/bin/evolve-blueprint.mjs plan --json`. It stages `blueprints/vN/` with the candidate, request/answers, impact, migration plan, exact generated baselines/staged copies, and digest-bound approval token.

Present classification, compatibility, affected/unaffected areas, risk, removals, environment changes, tests, rollback, and tasks. Do not apply.

Use `compare --from v1 --to v2 --json` or `--to draft` for comparison-only requests.

## 5. Apply only after approval

After explicit approval run:

```text
node .autopilot/bin/evolve-blueprint.mjs apply --version N --approve TOKEN --json
```

It fails if controller state, active blueprint, generated files, or plan changed. It merges queue state and generated control files only—never application code. Commit activation, provision credentials, preflight, then resume. High-risk tasks retain their execution approval boundary.

Never delete a project, silently remove behavior, rewrite accepted receipts, or perform destructive application changes during activation.
