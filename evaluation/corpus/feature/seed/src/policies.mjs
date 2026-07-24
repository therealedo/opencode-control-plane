export function activePolicyIds(policies) {
  if (!Array.isArray(policies)) throw new TypeError("policies must be an array")
  return policies.filter((policy) => policy.active === true).map((policy) => policy.id)
}
