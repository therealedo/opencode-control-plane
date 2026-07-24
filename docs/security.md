# Security boundaries

## Local policy boundary

Control Plane enforces application-level policy around each autonomous phase. Autonomous roles default-deny built-in tools and receive controller-owned bounded file tools plus exact task/MCP grants. Those file tools deny writes outside `allowed_paths`; reviewers cannot edit application files; and controller postflight checks reject unexpected changes to controller, Git, blueprint, project, credential, and OpenCode configuration paths.

These controls govern normal OpenCode tool use and detect protected-project mutations. They do not reduce the operating-system privileges of OpenCode or code launched by an approved gate. OpenCode phases run as fresh processes with selected environment, time, output, context, and process-tree cleanup. A separate reviewer is used because self-review inside the authoring session is not independent evidence.

## Commands and gates

Project text never becomes a shell command. Gates use fixed argument arrays stored in `.project/gates.json`, success-code allowlists, timeouts, and output caps. Git commands disable hooks, signing, pagers, ambient attributes, credential prompts, and global/system configuration to limit ambient Git behavior during controller-owned transactions.

## Credentials

Credential JSON contains only profile names, ignored environment-file paths, allowed variable names, and allowed gates. The controller reads exact values only for the selected scope and does not intentionally copy them into prompts, parent worker environments, Control Plane logs, receipts, or durable project files. A granted program or integration can still read or transmit values available to its process.

Use least-privilege test tenants. Never grant production or personal credentials to autonomous work.

## Framework upgrades

New projects record SHA-256 ownership for every managed framework file. Dynamic role grant blocks are normalized, and the `.ignore` managed block allows user lines outside it. Upgrades require a clean standalone Git worktree, no live controller, no active task, and no completion transaction. They stage and validate replacements, commit only the exact owned paths, and stop on drift.

Product files, `.project/`, blueprints, config, state, credentials, `.env*`, and task evidence are not generic upgrade targets.

For an unfinalized interview only, a guarded refresh can replace hash-owned framework files without requiring a clean baseline that does not yet exist. It requires an idle initializing state and no rendered/versioned blueprint, preserves the draft blueprint byte-for-byte, performs no remote Git action, and leaves the refreshed files for the normal baseline commit.

## Disposable evaluations

Evaluation never targets a registered or user-supplied existing project. The evaluator creates exclusive marker-owned candidates beneath its own temporary parent, rejects path redirection and linked candidate files, uses a private Control Plane home, and never invokes the registry, installer, or fleet updater. Bundled cases use no credentials, network requests, package installation, or production service.

Live evaluation is never automatic. It requires explicit spend confirmation, can consume the same provider quota and local resources as personal work, and cannot measure a subscription's remaining percentage. A trial is the budget unit: provider telemetry and elapsed time are committed after the trial, then soft limits are checked before another begins. One in-flight trial can cross a limit because its final usage is unknowable in advance.

## Global dashboard and registry

The global registry is a bounded atomic user file containing project paths and display metadata only. Registration canonicalizes real paths, deduplicates entries, uses a lock, and rejects linked or oversized control files. There is no recursive project discovery.

Fleet refreshes never execute project-local controller code; they read bounded regular files directly and isolate malformed or missing projects. Project code runs only after the user explicitly opens or acts on that project. The installed launcher pins the Node executable and trusted installed global runtime, so an arbitrary working directory cannot replace them through command lookup.

Release checks use a fixed unauthenticated GitHub endpoint, reject redirects and malformed/oversized responses, cache results, and fail offline without blocking control. Updates clone only the exact stable tag from the fixed repository. Automatic fleet updates never adopt legacy projects, kill workers, or claim cross-repository atomicity.

## Limitations

Local mode is an application-level policy boundary, not an operating-system sandbox. It provides no container or VM filesystem and network containment. A compiler, package script, browser, or native binary runs with the current operating-system account's privileges and can exceed the policy boundary. Use containers, VMs, restricted operating-system accounts, network controls, and disposable infrastructure when the toolchain is not trusted.
