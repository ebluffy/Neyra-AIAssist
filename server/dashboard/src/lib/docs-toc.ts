export type DocHeading = { id: string; text: string; level: number }

/** Build TOC from rehype-slug ids already in the rendered article. */
export function headingsFromArticle(root: ParentNode | null): DocHeading[] {
  if (!root) return []
  const nodes = root.querySelectorAll('h1[id], h2[id], h3[id]')
  return Array.from(nodes).map((el) => ({
    id: el.id,
    text: (el.textContent || '').trim(),
    level: Number(el.tagName.slice(1)),
  }))
}
