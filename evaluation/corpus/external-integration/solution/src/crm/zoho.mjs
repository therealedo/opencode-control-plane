import { normalizeContact } from "./contracts.mjs"

export function createZohoCrmAdapter({ request } = {}) {
  if (typeof request !== "function") throw new TypeError("request transport is required")

  async function send(message) {
    const response = await request(message)
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw new Error(`Zoho CRM request failed with status ${response?.status ?? "unknown"}`)
    }
    return response.body
  }

  return {
    async getContact(id) {
      if (typeof id !== "string" || !id.trim()) throw new TypeError("contact ID is required")
      const body = await send({
        method: "GET",
        path: `/crm/v2/Contacts/${encodeURIComponent(id)}`,
        body: null,
      })
      return normalizeContact(body?.data?.[0])
    },

    async addNote(contactId, text) {
      if (typeof contactId !== "string" || !contactId.trim()) throw new TypeError("contact ID is required")
      if (typeof text !== "string" || !text.trim()) throw new TypeError("note text is required")
      const body = await send({
        method: "POST",
        path: "/crm/v2/Notes",
        body: { data: [{ Parent_Id: { id: contactId }, Note_Content: text }] },
      })
      const noteId = body?.data?.[0]?.details?.id
      if (typeof noteId !== "string" || !noteId) throw new Error("Zoho CRM response omitted the note ID")
      return noteId
    },
  }
}
