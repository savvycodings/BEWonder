/** Profile / Wonder Store badge ids (keep aligned with app `wonderBadgesCatalog.ts`). */
export const WONDER_PROFILE_BADGE_IDS = new Set<string>([
  'badge:day7',
  'badge:day30',
  'badge:day90',
  'badge:order1',
  'badge:order5',
  'badge:order10',
  /** Legacy id — treated as gold (10 paid orders) and normalized to `badge:order10` on save. */
  'badge:order20',
  'badge:heart',
  'badge:wj_top100',
  'badge:wj_top50',
  'badge:wj_top10',
  'badge:wj_top3',
  'badge:wj_top2',
  'badge:wj_top1',
])

export function normalizeLegacyWonderBadgeId(id: string): string {
  return id === 'badge:order20' ? 'badge:order10' : id
}
