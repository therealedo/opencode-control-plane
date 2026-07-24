export function normalizePolicyId(value) {
  if (typeof value !== "string") throw new TypeError("policy ID must be a string")
  const normalized = value.trim().toUpperCase().replace(/[\s_]+/g, "-")
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(normalized)) {
    throw new Error("policy ID must contain alphanumeric segments")
  }
  return normalized
}
