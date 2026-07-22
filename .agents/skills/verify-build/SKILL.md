---
name: verify-build
description: Verify the active task against its acceptance checks and the repository quality matrix. Use after every implementation or repair and before the controller marks work done.
---

# Verify before completion

1. Review independently from a fresh session. Compare the task spec, `allowed_paths`, `.autopilot/runtime/candidate.json`, actual Git diff, acceptance criteria, and controller-supplied deterministic gate evidence.
2. Do not edit application files, run mutating commands, rerun gates, or assume missing evidence passed.
3. Request changes for a material defect, out-of-scope path, weakened check, failing gate, or unsupported acceptance claim. Use `blocked` only when review lacks required evidence or authority.
4. Write exactly one `.autopilot/runtime/review.json` object:
   `{schema_version:1,task_id,status:"approved|changes_requested|blocked",summary,findings:[{severity:"low|medium|high|critical",file,message}]}`

Approve only when required gates passed and no material finding remains. The reviewer may write only this review file; the controller owns transitions and receipts.
