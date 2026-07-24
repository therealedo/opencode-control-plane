export function activePolicyIds(policies) {
  if (!Array.isArray(policies)) throw new TypeError("policies must be an array")
  return policies.filter((policy) => policy.active === true).map((policy) => policy.id)
}

export function summarizeActivePremiums(policies, currency) {
  if (!Array.isArray(policies)) throw new TypeError("policies must be an array")
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("currency must be a three-letter uppercase code")
  }
  const active = policies.filter((policy) => policy.active === true)
  let total = 0
  for (const policy of active) {
    if (!Number.isSafeInteger(policy.premium_cents) || policy.premium_cents < 0) {
      throw new TypeError("active premiums must be non-negative safe integers")
    }
    total += policy.premium_cents
    if (!Number.isSafeInteger(total)) throw new RangeError("premium total exceeds safe integer range")
  }
  return { active_count: active.length, total_cents: total, currency }
}
