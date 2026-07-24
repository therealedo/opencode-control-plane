# OpenCode Control Plane

> a high-efficiency, zero-token orchestrator that turns OpenCode into a sandboxed, self-verifying coding worker. Keeping it lean, fast, and terminal-native is its superpower

Describe a project once. OpenCode Control Plane divides the work into small tasks, starts fresh coding and review sessions, runs tests, recovers from context limits, and keeps working until it reaches a real human boundary.

The controller and terminal dashboard use no model tokens. Only the OpenCode workers use your chosen model.

## Install once

You need OpenCode, Node.js 20 or newer, and Git.

```text
git clone https://github.com/therealedo/opencode-control-plane.git
cd opencode-control-plane
npm run setup
```

Close and reopen OpenCode and your terminal after setup.

Setup installs:

- `/init-project` and `/evolve-project` in OpenCode;
- the global `control-plane` terminal dashboard;
- no model setting and no global `opencode.json` change.

If setup says the command folder is not on your PATH, add the exact folder it prints to your user PATH once, then reopen the terminal. Setup never edits your PATH silently.

## Start a project

1. Create an empty project folder.
2. Open a terminal in it and run `opencode .`.
3. Enter `/init-project`.
4. Answer the interview. You can paste an existing project brief or chat first and ask it to question only missing or ambiguous areas.
5. Give environment-variable names, never secret values.

When the interview is complete, deterministic scripts create the modular project files, Blueprint v1, tests and worker configuration, commit a clean baseline, register the project, and check readiness. They deliberately stop before the first worker starts.

Open `control-plane` in another terminal, select the project, choose **Worker reasoning** until the desired model variant is shown, then choose **Start worker**. This setting applies to every fresh autonomous worker; changing `/variants` in the interview session alone does not carry into those isolated sessions.

## Monitor every project

Open a separate terminal anywhere and run:

```text
control-plane
```

The first screen shows all registered projects, which workers are running, progress, blueprint versions, problems, and available framework updates.

- Up/Down selects a project; Left/Right selects a visible action; Enter runs it. The active project and option are highlighted in color, with visible arrow hints. Letter shortcuts still work.
- O or **Open project** opens that project's full controls. It is highlighted by default when a project is available, so Enter opens it immediately.
- A or **Add project** opens an in-terminal folder picker. Type to see matching next folders, use Up/Down to choose, Right/Tab to browse into the selected folder, Left to go back, and Enter to validate and add the highlighted folder.
- F forgets a missing or unwanted entry; it never deletes the project.
- C checks GitHub for a new release.
- U updates the Control Plane and registered projects safely.
- Q closes only the dashboard; workers keep running.

Inside a project you can set worker reasoning, check readiness, start, pause, stop, resume, update its blueprint, or return to the wide view. Pause first if you want to change reasoning while a project is already running. The old project-local `control-plane.cmd` or `./control-plane` launcher remains available as a fallback.

The dashboard runs only while its terminal is open. There is no server, daemon, browser UI, database, or background model session.

## When a requirement changes

Open the project from `control-plane` and choose **Change product blueprint**.

The system uses the existing blueprint and project memory, asks only about the changed area, and classifies the change:

- documentation changes update metadata;
- feature changes add implementation tasks;
- architecture changes create a new blueprint version and migration plan.

Application code is not rebuilt during planning. Breaking or destructive work requires your approval and a rollback plan.

## Update everything

The dashboard checks the public repository's latest stable tagged release automatically when it opens. Network failure never blocks project control.

When an update is shown, press U once. The Control Plane will:

1. download the exact public release tag;
2. validate and transactionally update the global installation;
3. ask running projects to finish their current safe unit;
4. update each registered project with its trusted global updater;
5. create a reversible local Git commit in each changed project;
6. resume only workers that were running before the update.

It never kills a worker, silently adopts a legacy project, overwrites application code, or hides a failed project. If one project is dirty, unavailable, or blocked, other safe projects still update; fix the named problem and press U again.

### Upgrade from Control Plane 1.0

Version 1.0 does not yet have the global dashboard. From your Control Plane repository, run once:

```text
npm run upgrade -- --local
```

Then reopen the terminal, run `control-plane`, choose **Add project**, and select each existing initialized project folder. Choose **Update everything** to update the registered projects. A pre-versioned legacy project is never adopted automatically; use its separately reviewed adoption command when the dashboard tells you it is required.

## Secrets and test accounts

Store real test credentials only in the ignored local environment file selected during initialization. The blueprint, prompts, project memory, Git history, receipts, screenshots, and registry must contain names only.

Use limited test tenants—not production or personal accounts. A credential is exposed only to the approved gate or integration that needs it.

## How it stays efficient

- Scripts create and update known structures instead of asking a model to write boilerplate.
- `AGENTS.md` is a small manual/recovery router and is not reloaded into every autonomous phase.
- Each task, repair, and independent review uses a fresh OpenCode session.
- A deterministic compiler sends only the task's selected project facts, paths, tools, and test credentials while preserving code blocks exactly.
- Workers inspect narrowly, reuse existing/native capabilities before adding code, and reviewers reject needless files, dependencies, configuration, and abstractions without relaxing quality or safety.
- Tests, Git transitions, status polling, upgrades, and context handoffs are deterministic and token-free.
- Tool results and worker contracts are paginated and bounded; full evidence stays in artifacts instead of prompts.
- Blueprints and receipts preserve durable memory without growing every prompt, while receipts record actual model usage for release comparisons.

## If something goes wrong

- **`control-plane` is not recognized:** reopen the terminal. If it still fails, add the setup-reported command folder to your user PATH.
- **Not ready:** open the project and choose **Check readiness**; fix the first named item, then Start.
- **Waiting for you:** complete the exact action shown, then Resume.
- **Update deferred:** resolve the active blocker or dirty Git worktree, return to a safe boundary, and press U again.
- **Managed-file drift:** do not force the update. Restore or review the named Control Plane-owned file first.
- **Project moved:** press F on the missing entry, then A and select its new folder.

## Maintainers

Keep the system dependency-free and put deterministic work in scripts. Every behavior release must use the same version in `package.json` and `control-plane-release.json`, a matching `vMAJOR.MINOR.PATCH` Git tag, and a stable GitHub Release.

```text
npm run check
npm run upgrade -- --local --all-projects
```

More detail:

- [Product roadmap](roadmap.md)
- [Architecture and context lifecycle](docs/architecture.md)
- [Token-efficiency design and measurements](docs/token-efficiency.md)
- [Blueprint initialization and evolution](docs/blueprints.md)
- [Security boundaries](docs/security.md)
- [Maintenance and releases](docs/maintenance.md)

Repository: [therealedo/opencode-control-plane](https://github.com/therealedo/opencode-control-plane)
