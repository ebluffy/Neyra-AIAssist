import { describe, expect, it } from 'vitest'
import { headingsFromArticle } from '../lib/docs-toc'

describe('headingsFromArticle', () => {
  it('reads rehype-slug ids and plain text including nested markup', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <h1 id="stage-1b">Этап <code>1b</code></h1>
      <h2 id="install">Установка</h2>
      <h2 id="install-1">Установка</h2>
      <pre><code># not a heading</code></pre>
    `
    expect(headingsFromArticle(root)).toEqual([
      { id: 'stage-1b', text: 'Этап 1b', level: 1 },
      { id: 'install', text: 'Установка', level: 2 },
      { id: 'install-1', text: 'Установка', level: 2 },
    ])
  })

  it('returns empty for null', () => {
    expect(headingsFromArticle(null)).toEqual([])
  })
})
