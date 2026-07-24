---
name: init-project
description: Initialize a new project with OpenCode Control Plane, including its modular blueprint, policy-bounded autonomous worker loop, terminal dashboard, testing boundaries, and versioned upgrade ownership.
---

# Initialize OpenCode Control Plane

Use only in a new project. Define the control plane; do not implement the product.

## Scaffold

Run:

```text
node <skill-directory>/bin/scaffold.mjs --target <project-root> --json
```

The target may contain only `.git/` and `.gitignore`; there is no overwrite mode. Never recreate managed files manually.

## Interview and blueprint

Ask focused questions, then edit only `.autopilot/init/blueprint.json`. Cover:

1. outcome, users, scope, success, completion;
2. languages, architecture decisions, dependencies/components, contracts, constraints;
3. autonomy, security, quality, test services, ignores, ephemeral roots, environment names;
4. OpenCode model/auth, budgets, gates, grants, credentials, MCPs;
5. roadmap and small dependency-ordered tasks.

Preserve `schema_version: 6`, starter shapes/bounds, concise text, and variable names only—never secret values. Consequential decisions need stable IDs, choice/rationale, rejected alternatives, dependencies, generated components, paths, environment names, and tests. Set one `provider/model`, explicit auth mode, and auth variable names.

Git stays local: initialize the baseline but never change or push a remote. Use one `git.commit_prefix`, or map every task ID in `git.commit_prefixes` to `feat|fix|refactor|test|docs|chore|ci|build|security`, optionally scoped like `feat(opportunities)`. Choose while planning; the runtime never chooses. Mapped bookkeeping uses `chore(control-plane)`.

Every gate needs `feedback`; true means deterministic, non-mutating, credential-free implementation feedback. Phase profiles allow only `opencode`; gate profiles list gate IDs. Profiles contain only `env_file`, exact `allow` names, and `allowed_gates`. MCP environment placeholders must be allowed by the phase profile. Local MCPs use trusted fixed argv, no caller `cwd`, optional environment placeholders, and a timeout; remote MCPs require HTTPS. Tasks select exact grants.

Task context is `{ "shared": [], "execute": [], "repair": [], "review": [] }`. Put invariants/security in `shared`; add only phase-needed bundles. Do not load receipts or grant all context/tools by default.

Each ephemeral path must be a literal disposable directory root with a matching ignore, no task overlap, and no control/credential path. Do not handwrite generated files or managed grants.

Each task needs an ID, dependencies, bounded outcome/evidence, phase context/grants, paths, gates, risk, and attempt limit. Prefer a walking skeleton and vertical slices. Put every final gate on one terminal task whose transitive dependencies cover all tasks.

## Finalize

Run once:

```text
node <skill-directory>/bin/finalize-and-launch.mjs --target <project-root> --json
```

It deterministically renders Blueprint v1 and project memory, records ownership/version, validates packets, commits the baseline, removes drafts, registers the project, upgrades an older interview scaffold when needed, and preflights without starting a worker. Configure missing Git identity and rerun. On success tell the user to open `control-plane`, choose **Worker reasoning** if desired, and select **Start worker**. This deliberate zero-token checkpoint lets runtime reasoning change without changing the blueprint or losing interview answers. If `ready: false`, report only named provisioning failures; leave it idle for dashboard readiness/start. Registration failure is nonfatal and can be fixed from the dashboard.

Only pass `--variant <id> --start` when the user explicitly selected that provider variant and explicitly asked for immediate launch. A `/variants` choice in the interview session is not inherited by fresh workers unless it is saved through this argument or the dashboard.

Use other zero-model scripts only for diagnosis.
