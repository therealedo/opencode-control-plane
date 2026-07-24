# Add an active-policy premium summary

Preserve `activePolicyIds(policies)` and add `summarizeActivePremiums(policies, currency)` in `src/policies.mjs`.

Return `{ active_count, total_cents, currency }` for active policies only. Require an array, a three-letter uppercase currency, and non-negative safe-integer `premium_cents` values on active policies. Do not mutate input, add dependencies, or access the network.
