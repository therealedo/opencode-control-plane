# Security boundaries

## Worker isolation

Autonomous roles default-deny built-in tools. They receive controller-owned bounded file tools and only exact task/MCP grants. Workers can write within `allowed_paths`; reviewers cannot edit application files. Controller, Git, blueprint, project, credential, and OpenCode configuration paths are protected.

OpenCode phases run as fresh processes with bounded environment, time, output, context, and process-tree cleanup. A separate reviewer is used because self-review inside the authoring session is not independent evidence.

## Commands and gates

Project text never becomes a shell command. Gates use fixed argument arrays stored in `.project/gates.json`, success-code allowlists, timeouts, and output caps. Git commands disable hooks, signing, pagers, ambient attributes, credential prompts, and global/system configuration where the transaction requires isolation.

## Credentials

Credential JSON contains only profile names, ignored environment-file paths, allowed variable names, and allowed gates. The controller reads exact values only for the selected scope and keeps them out of prompts, parent worker environments, logs, receipts, and durable project files.

Use least-privilege test tenants. Never grant production or personal credentials to autonomous work.

## Framework upgrades

New projects record SHA-256 ownership for every managed framework file. Dynamic role grant blocks are normalized, and the `.ignore` managed block allows user lines outside it. Upgrades require a clean standalone Git worktree, no live controller, no active task, and no completion transaction. They stage and validate replacements, commit only the exact owned paths, and stop on drift.

Product files, `.project/`, blueprints, config, state, credentials, `.env*`, and task evidence are not generic upgrade targets.

## Global dashboard and registry

The global registry is a bounded atomic user file containing project paths and display metadata only. Registration canonicalizes real paths, deduplicates entries, uses a lock, and rejects linked or oversized control files. There is no recursive project discovery.

Fleet refreshes never execute project-local controller code; they read bounded regular files directly and isolate malformed or missing projects. Project code runs only after the user explicitly opens or acts on that project. The installed launcher pins the Node executable and trusted installed global runtime, so an arbitrary working directory cannot replace them through command lookup.

Release checks use a fixed unauthenticated GitHub endpoint, reject redirects and malformed/oversized responses, cache results, and fail offline without blocking control. Updates clone only the exact stable tag from the fixed repository. Automatic fleet updates never adopt legacy projects, kill workers, or claim cross-repository atomicity.

## Limitations

The sandbox is an application-level boundary. A compiler, package script, browser, native binary, or operating-system vulnerability can exceed it. Use containers, VMs, restricted operating-system accounts, network controls, and disposable infrastructure when the toolchain is not trusted.
