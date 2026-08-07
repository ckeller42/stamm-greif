// Extracts the first human-readable error message from a Payload REST error body
// ({ errors: [{ message }] }); afterError has already suffixed it with the Fehler-ID.
export function formatServerError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const errors = (body as { errors?: unknown }).errors
  if (!Array.isArray(errors) || errors.length === 0) return null
  const first = errors[0]
  if (typeof first !== 'object' || first === null) return null
  const message = (first as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : null
}
