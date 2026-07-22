---
name: fix-bug
description: Diagnose and repair a reproducible runtime, test, build, or logic failure for the active task. Use after verification fails or when the user reports a concrete defect.
---

# Repair a failure

1. Accept the controller-supplied task ID, attempt, failure fingerprint, and bounded evidence. Resolve the spec and context through `.project/plan/queue.json` and `.project/manifest.json`.
2. Reproduce once when safe, distinguish root cause from symptoms, and make at most one minimal fix inside `allowed_paths`; use `autopilot_mutate` for deletes, moves, or executable-bit changes.
3. Add or refine a regression test. When exposed, use only `autopilot_check`'s listed credential-free gates and at most twice; the controller reruns every fixed gate. Never invoke a shell. Stop when evidence is insufficient, the fingerprint persists, or a boundary must change.
4. Make `changed_files` exactly match the actual Git task diff. List environment-variable names only.
5. Write exactly one `.autopilot/runtime/candidate.json` object:
   `{schema_version:1,task_id,attempt,status:"complete|blocked|failed",summary,changed_files:[],environment_variables:[],blocker:null|{kind,message,required_action,resume_condition}}`

Use `blocked` with all four blocker fields when human action is required; otherwise `blocker` must be null. Do not edit any other control file or invoke review yourself.
