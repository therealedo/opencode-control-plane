function validEvent(event) {
  return event && typeof event === "object" && typeof event.id === "string" && event.id.length > 0
}

export function appendCallEvent(log, event) {
  if (!Array.isArray(log)) throw new TypeError("log must be an array")
  if (!validEvent(event)) throw new TypeError("event must have an ID")
  return [...log, event]
}

export function resumeCallLog(log, events) {
  if (!Array.isArray(log) || !Array.isArray(events)) throw new TypeError("log and events must be arrays")
  if (![...log, ...events].every(validEvent)) throw new TypeError("every event must have an ID")
  const result = []
  const seen = new Set()
  for (const event of [...log, ...events]) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    result.push(event)
  }
  return result
}
