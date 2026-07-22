# Quality contract

## Definition of done

A task is complete only when:

- every acceptance criterion has evidence;
- its required gates pass with approved success codes;
- independent review accepts the diff;
- no unresolved blocker or high-risk regression remains;
- the controller records a receipt and marks the queue item done.

## Testing shape

- Prefer the narrowest deterministic check while iterating.
- Run all task gates before review and all `final_gates` before project completion.
- Treat skipped, flaky, or unavailable checks as explicit evidence gaps, not passes.
- Keep gate output bounded; store larger artifacts under `.autopilot/artifacts/`.

## Review priorities

Correctness, security, data integrity, acceptance coverage, regression risk, then maintainability.
