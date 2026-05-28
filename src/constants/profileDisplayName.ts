export const MAX_PROFILE_DISPLAY_NAME_LENGTH = 15

/** Returns an API error message, or null when valid. */
export function validateProfileDisplayName(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const name = String(raw).trim()
  if (!name) return 'fullName cannot be empty'
  if (name.length > MAX_PROFILE_DISPLAY_NAME_LENGTH) {
    return `Name must be ${MAX_PROFILE_DISPLAY_NAME_LENGTH} characters or fewer`
  }
  return null
}
