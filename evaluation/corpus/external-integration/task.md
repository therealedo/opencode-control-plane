# Add a Zoho CRM adapter

Create `src/crm/zoho.mjs` and export `createZohoCrmAdapter({ request })`.

The adapter must use only the injected async `request` transport and expose:

- `getContact(id)`, issuing `GET /crm/v2/Contacts/{encoded-id}` and returning the provider-neutral contact from `normalizeContact`.
- `addNote(contactId, text)`, issuing `POST /crm/v2/Notes` with a Zoho note payload and returning the created note ID.

Validate required inputs and throw a bounded error containing the response status on non-2xx responses. Do not read credentials, call `fetch`, open sockets, or add dependencies.
