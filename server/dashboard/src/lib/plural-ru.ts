/** Russian plural form for countable nouns (Intl.PluralRules). */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n))
  const cat = new Intl.PluralRules('ru').select(abs)
  if (cat === 'one') return one
  if (cat === 'few') return few
  return many
}
