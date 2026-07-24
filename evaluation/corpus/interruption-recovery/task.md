# Make call-event recovery idempotent

Preserve `appendCallEvent(log, event)` and add `resumeCallLog(log, events)`.

Recovery may replay events after a worker interruption. Return a new log containing each event ID once, preserve the first recorded value for duplicate IDs, append genuinely new events in input order, and leave both inputs unchanged. Reject malformed inputs. Add no dependencies or network access.
