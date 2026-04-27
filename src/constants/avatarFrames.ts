/** Avatar frame ids stored on `usders.avatar_frame` and returned by auth / chat. */
export const ALLOWED_AVATAR_FRAME_IDS = [
  'none',
  'neon',
  'gold',
  'rainbow',
  'prism',
  'meridian',
  'hex',
  'shard',
] as const

export type AllowedAvatarFrameId = (typeof ALLOWED_AVATAR_FRAME_IDS)[number]

export const ALLOWED_AVATAR_FRAMES = new Set<string>(ALLOWED_AVATAR_FRAME_IDS)

export function normalizeStoredAvatarFrameId(raw: string | null | undefined): string {
  const v = String(raw ?? 'none').trim()
  return ALLOWED_AVATAR_FRAMES.has(v) ? v : 'none'
}
