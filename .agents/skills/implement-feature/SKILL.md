---
name: implement-feature
description: Implement one controller-selected task from the autonomous project queue. Use when .autopilot/state.json identifies an active feature or milestone that is ready for code changes.
---

# Implement the active task

1. Accept the controller-supplied task ID and attempt. Resolve its spec and context through `.project/plan/queue.json` and `.project/manifest.json`; read nothing unrelated.
2. Inspect the shared worktree. Preserve unrelated edits and change only paths matched by the task's `allowed_paths`.
3. Implement the smallest coherent behavior and focused tests. Use `autopilot_mutate` for any file delete, move, or executable-bit change. When the phase exposes `autopilot_check`, use only its listed credential-free gates and at most twice; those diagnostics are not final evidence. The controller reruns every fixed gate. Never invoke a shell, commit, access secrets, or weaken a check.
4. Make `changed_files` exactly match the actual Git task diff. List environment-variable names only.
5. Write exactly one `.autopilot/runtime/candidate.json` object:
   `{schema_version:1,task_id,attempt,status:"complete|blocked|failed",summary,changed_files:[],environment_variables:[],blocker:null|{kind,message,required_action,resume_condition}}`

Use `blocked` only for a concrete authority, credential, external-action, or scope boundary; otherwise `blocker` must be null. Do not edit any other control file or invoke review/repair yourself.
