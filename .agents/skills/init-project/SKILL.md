---
name: init-project
description: Initialize a new project with OpenCode Control Plane, including its modular blueprint, sandboxed autonomous worker loop, terminal dashboard, testing boundaries, and versioned upgrade ownership.
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

Preserve `schema_version: 5`, starter shapes/bounds, concise text, and variable names only—never secret values. Consequential decisions need stable IDs, choice/rationale, rejected alternatives, dependencies, generated components, paths, environment names, and tests. Set one `provider/model`, explicit auth mode, auth variable names, and Git prefix.

Every gate needs `feedback`; true means deterministic, non-mutating, credential-free implementation feedback. Phase profiles allow only `opencode`; gate profiles list gate IDs. Profiles contain only `env_file`, exact `allow` names, and `allowed_gates`. MCP environment placeholders must be allowed by the phase profile. Local MCPs use trusted fixed argv, no caller `cwd`, optional environment placeholders, and a timeout; remote MCPs require HTTPS. Tasks select exact grants.

Task context is `{ "shared": [], "execute": [], "repair": [], "review": [] }`. Put invariants/security in `shared`; add only phase-needed bundles. Do not load receipts or grant all context/tools by default.

Each ephemeral path must be a literal disposable directory root with a matching ignore, no task overlap, and no control/credential path. Do not handwrite generated files or managed grants.

Each task needs an ID, dependencies, bounded outcome/evidence, phase context/grants, paths, gates, risk, and attempt limit. Prefer a walking skeleton and vertical slices. Put every final gate on one terminal task whose transitive dependencies cover all tasks.

## Finalize

Run once:

```text
node <skill-directory>/bin/finalize-and-launch.mjs --target <project-root> --json
```

It deterministically renders Blueprint v1 and project memory, records ownership/version, validates packets, commits the baseline, removes drafts, registers the project, preflights, and starts the detached controller when ready. Configure missing Git identity and rerun. On success report the PID and `control-plane`; do not ask the user to start it again. If `ready: false`, report only named provisioning failures; leave it idle for dashboard readiness/start. Registration failure is nonfatal and can be fixed from the dashboard.

Use other zero-model scripts only for diagnosis.
