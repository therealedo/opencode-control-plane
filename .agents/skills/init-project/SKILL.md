---
name: init-project
description: Initialize a new project with OpenCode Control Plane, including its modular blueprint, sandboxed autonomous worker loop, terminal dashboard, testing boundaries, and versioned upgrade ownership.
---

# Initialize OpenCode Control Plane

Use in a new project. Define the control plane; do not implement the product.

## 1. Scaffold deterministically

Run:

```text
node <skill-directory>/bin/scaffold.mjs --target <project-root> --json
```

The target may contain only `.git/` and `.gitignore`. There is no overwrite/`--force` mode. Never recreate control files manually.

## 2. Fill one structured blueprint

Ask focused questions and edit only `.autopilot/init/blueprint.json`:

1. outcome, users, scope, success, completion;
2. languages, architecture decisions, dependencies/components, contracts/invariants, constraints;
3. autonomy, security, quality, test services, ignores/ephemeral roots, environment names;
4. OpenCode model/auth, budgets, gates, grants, credentials, and MCPs;
5. roadmap and bounded dependency-ordered tasks.

Keep `schema_version: 5`, starter shapes/bounds, concise text, and names only—never secret values. Each consequential architecture decision needs a stable ID, choice, rationale, rejected alternatives, dependencies, generated components, affected paths, environment names, and test areas. Set one `provider/model`, explicit auth mode, exact environment-auth variables, and the starter Git prefix. Every gate needs `feedback`; use true only for deterministic, non-mutating, credential-free implementation feedback. Phase profiles reserve `allowed_gates: ["opencode"]`; gate profiles list gate IDs. An MCP `{env:NAME}` must be allowed by its phase profile.

Task context is `{ "shared": [], "execute": [], "repair": [], "review": [] }`. Put invariants/security in `shared`; load other bundles only where needed. Reserve complete candidate/gate and diff evidence.

Profiles contain only `env_file`, exact `allow` names, and `allowed_gates`. Local MCPs use trusted external fixed argv, no caller `cwd`, optional `{env:NAME}`, and a timeout. Remote MCPs use HTTPS plus optional `{env:NAME}` headers. Tasks select exact phase grants; runtime injects only that subset.

Each `tooling.ephemeral` value is a literal disposable directory root with a matching ignore and no task-path overlap. Control/credential paths are forbidden.

Do not handwrite generated project/control files or managed grants; the finalizer owns them.

## 3. Make the plan executable

Each task needs an ID, dependencies, bounded outcome/evidence, phase context/grants, allowed paths, gates, risk, and attempt limit. Prefer a walking skeleton then small vertical slices. Do not load receipts or grant all context/tools by default.

Put every `final_gates` ID on one terminal task whose transitive dependencies cover all tasks. This keeps final defects inside the normal repair loop.

## 4. Validate and launch

Run this skill's deterministic closeout once:

```text
node <skill-directory>/bin/finalize-and-launch.mjs --target <project-root> --json
```

It renders, creates Blueprint v1/current memory, records the installed Control Plane version, syncs grants, validates packet sizes, commits a clean baseline, removes draft init files, registers the project in the global terminal dashboard, preflights without a model, and starts the detached controller only when ready. Configure missing Git identity and rerun. On success report the PID and tell the user to run `control-plane` from any terminal; do not ask them to start the already-running worker. If `ready: false`, report only named `provisioning` failures and leave state idle; the dashboard handles readiness and start after provisioning. Registration failure is nonfatal and is returned explicitly; the user can add the folder from the dashboard.

Use the separate zero-model scripts only for diagnosis.
