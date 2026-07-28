# OpenCode Control Plane

A high-efficiency, zero-token orchestrator that turns OpenCode into a policy-bounded, self-verifying coding worker. Keeping it lean, fast, and terminal-native is its superpower.

Repository: https://github.com/therealedo/opencode-control-plane.git

Control Plane is **project-local**. It does not need global skills, global OpenCode commands, or a PATH launcher.

## Install it in a new project

1. Clone or update this repository.
2. Create an empty folder for your project.
3. From this repository, run:

```powershell
.\install-project.cmd "C:\path\to\your-project"
```

4. Open that project folder in OpenCode.
5. Run `/init-project` and complete the interview.
6. After finalization, open `control-plane.cmd` inside the project and choose **Start worker**.

Nothing is installed in your user profile. The project gets its own `init-project` and `evolve-project` skills, OpenCode commands, controller, and dashboard.

## Daily use

Inside an initialized project:

- `control-plane.cmd` opens that project's dashboard.
- **Start/Resume worker** runs autonomous development.
- **Check readiness** performs deterministic zero-token checks.
- **Worker reasoning** changes the model variant used by the next fresh worker session.
- **Change product blueprint** starts targeted blueprint evolution.
- **Upgrade Control Plane** updates only that project from this source checkout.

From this repository, `control-plane.cmd` opens the fleet dashboard. Its private project list lives in `.control-plane-home/` inside this checkout and is not committed.

## Work without Control Plane

If Control Plane has a bug and you need to work manually:

```powershell
.\manual-mode.cmd on
```

This refuses to activate while a worker is running, then blocks autonomous Start/Resume. Work normally with OpenCode using explicit requests.

When ready to return:

```powershell
.\manual-mode.cmd off
```

Then run **Check readiness** before resuming the worker.

## Update

Update this repository, then use either:

- **Update everything** in this repository's fleet dashboard; or
- **Upgrade Control Plane** inside one project.

Every project keeps its own installed version. A broken release in one project does not prevent manual work in another.

## Remove the old global installation

Preview exactly what will be removed:

```powershell
npm run uninstall:global -- --dry-run
```

Then remove only manifest-owned Control Plane files:

```powershell
npm run uninstall:global
```

The uninstaller preserves unrelated skills and OpenCode configuration and migrates the old project list into this checkout's local fleet dashboard.

## What each important file does

- `install-project.cmd`: installs or refreshes Control Plane in one project.
- `control-plane.cmd`: opens the source-local fleet dashboard.
- `scripts/install-project.mjs`: guarded transactional project installer.
- `scripts/uninstall-global.mjs`: manifest-verified legacy global removal.
- `.agents/skills/init-project/`: initialization interview, scaffold, controller template, and upgrade logic.
- `.agents/skills/evolve-project/`: versioned blueprint changes and migration planning.
- `roadmap.md`: shipped work and planned releases.

## Safety model

- Never overwrites project-local Control Plane files that drifted outside the installer.
- Never automatically deletes application code or an initialized project.
- Upgrades use the existing guarded project migration path.
- Global removal deletes only hash-verified manifest-owned outputs.
- Manual mode and autonomous mode cannot run at the same time.
