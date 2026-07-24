export function normalizeContact(record) {
  if (!record || typeof record !== "object") throw new TypeError("contact record is required")
  return {
    id: String(record.id),
    name: typeof record.Full_Name === "string" ? record.Full_Name : "",
    email: typeof record.Email === "string" ? record.Email : "",
  }
}
