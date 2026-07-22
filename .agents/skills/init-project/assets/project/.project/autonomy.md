# Autonomy policy

## May proceed unattended

- Implement one ready task inside its `allowed_paths`.
- Run gate IDs assigned to that task.
- Make local, reversible edits and local commits when configured.
- Roll the run ledger automatically at safe boundaries when task-count or elapsed-time accounting thresholds are reached.

## Must stop for a human

- Product intent or acceptance criteria are ambiguous.
- Required credentials, access, or a physical/dashboard action is missing.
- An action affects production, users, money, public content, remote data, or irreversible state.
- A fix needs files outside `allowed_paths`, changes an invariant, or expands scope.
- An attempt or no-progress hard limit is exhausted, or required context cannot fit its declared cap.

Create no substitute credentials and never weaken a gate to get green. The Node controller owns queue state, receipts, runtime state, commits, and `STOP`/`PAUSED`; direct phase roles return only scoped work and evidence.
