export function appendCallEvent(log, event) {
  if (!Array.isArray(log)) throw new TypeError("log must be an array")
  return [...log, event]
}
