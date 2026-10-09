import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { BookOpenText, ExternalLink, FileText, Search } from 'lucide-react'
import remarkGfm from 'remark-gfm'
import { apiGet, apiGetText } from '../api'
import type { ApiEnvelope } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

type DocItem = { id: string; title: string; path?: string; lang?: string }
type DocSection = { id: string; title: string; items: DocItem[] }
type Heading = { id: string; text: string; level: number }

const REPORT_ISSUE_URL = 'https://github.com/ebluffy/Neyra-AIAssist/issues/new'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

function extractHeadings(md: string): Heading[] {
  const out: Heading[] = []
  const seen = new Map<string, number>()
  for (const line of md.split('\n')) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line.trim())
    if (!m) continue
    const text = m[2].replace(/[*_`#]/g, '').trim()
    if (!text) continue
    let id = slugify(text) || 'section'
    const n = (seen.get(id) ?? 0) + 1
    seen.set(id, n)
    if (n > 1) id = `${id}-${n}`
    out.push({ id, text, level: m[1].length })
  }
  return out
}

export function DocsScreen() {
  const [sections, setSections] = useState<DocSection[]>([])
  const [tab, setTab] = useState('')
  const [docId, setDocId] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [error, setError] = useState('')
  const [loadingCat, setLoadingCat] = useState(true)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [headingQuery, setHeadingQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingCat(true)
      try {
        const r = await apiGet<ApiEnvelope<{ sections: DocSection[] }>>('/v1/docs/catalog')
        if (cancelled) return
        const secs = r.data.sections ?? []
        setSections(secs)
        const first = secs[0]
        if (first) {
          setTab(first.id)
          if (first.items[0]) setDocId(first.items[0].id)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoadingCat(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const activeSection = useMemo(
    () => sections.find((s) => s.id === tab) ?? sections[0],
    [sections, tab],
  )

  const headings = useMemo(() => extractHeadings(markdown), [markdown])
  const filteredHeadings = useMemo(() => {
    const q = headingQuery.trim().toLowerCase()
    if (!q) return headings
    return headings.filter((h) => h.text.toLowerCase().includes(q))
  }, [headings, headingQuery])

  useEffect(() => {
    if (!docId) return
    let cancelled = false
    ;(async () => {
      setLoadingDoc(true)
      setError('')
      setHeadingQuery('')
      try {
        const text = await apiGetText(`/v1/docs/markdown/${docId}`)
        if (!cancelled) setMarkdown(text)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setMarkdown('')
        }
      } finally {
        if (!cancelled) setLoadingDoc(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId])

  return (
    <div className="page-content stack">
      <PageHeader
        title="Документация"
        subtitle="Markdown из репозитория и ссылки на OpenAPI"
        actions={
          <a
            className="btn btn-secondary btn-sm"
            href={REPORT_ISSUE_URL}
            rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
            target="_blank"
          >
            Сообщить о проблеме <ExternalLink aria-hidden size={12} />
          </a>
        }
      />

      <div className="card">
        <div className="card-header">
          <BookOpenText size={15} className="card-icon card-icon-cyan" />
          <span className="card-title">OpenAPI (интерактивно)</span>
        </div>
        <div className="row">
          {[
            ['/docs', 'Swagger UI'],
            ['/redoc', 'ReDoc'],
            ['/openapi.json', 'OpenAPI JSON'],
          ].map(([href, label]) => (
            <a
              key={href}
              className="btn btn-secondary btn-sm"
              href={href}
              rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
              target="_blank"
            >
              {label} <ExternalLink aria-hidden size={12} />
            </a>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <FileText size={15} className="card-icon" />
          <span className="card-title">Markdown-документы</span>
        </div>
        {loadingCat ? (
          <Skeleton className="h-10" />
        ) : (
          <>
            <div className="tabs-row" role="tablist" aria-label="Разделы документации">
              {sections.map((s) => (
                <Button
                  key={s.id}
                  onClick={() => {
                    setTab(s.id)
                    if (s.items[0]) setDocId(s.items[0].id)
                  }}
                  size="sm"
                  type="button"
                  variant={tab === s.id ? 'default' : 'secondary'}
                >
                  {s.title}
                </Button>
              ))}
            </div>
            <div className="docs-layout">
              <div className="docs-nav" role="navigation" aria-label="Файлы">
                {(activeSection?.items ?? []).map((it) => (
                  <button
                    key={it.id}
                    className={`docs-nav-item${docId === it.id ? ' active' : ''}`}
                    onClick={() => setDocId(it.id)}
                    type="button"
                  >
                    <span className="docs-nav-title">{it.title}</span>
                    <span className="docs-nav-id">{it.id}</span>
                  </button>
                ))}
                {!activeSection?.items?.length && (
                  <EmptyState
                    description="Скопируй docs/ на сервер или открой HELP."
                    icon={FileText}
                    title="Пусто"
                  />
                )}
              </div>
              <div className="docs-body">
                {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
                {loadingDoc ? (
                  <div className="stack-sm">
                    <Skeleton style={{ height: 22, width: '40%' }} />
                    <Skeleton style={{ height: 16, width: '100%' }} />
                  </div>
                ) : markdown ? (
                  <div className="docs-article-wrap">
                    {headings.length > 0 ? (
                      <aside aria-label="Оглавление" className="docs-toc">
                        <label className="label" style={{ marginBottom: '0.5rem' }}>
                          <span className="label-text" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Search aria-hidden size={13} /> Поиск по заголовкам
                          </span>
                          <input
                            className="input"
                            onChange={(e) => setHeadingQuery(e.target.value)}
                            placeholder="Фильтр…"
                            type="search"
                            value={headingQuery}
                          />
                        </label>
                        <nav className="docs-toc-list">
                          {filteredHeadings.map((h) => (
                            <a
                              key={h.id}
                              className={`docs-toc-item level-${h.level}`}
                              href={`#${h.id}`}
                              onClick={(e) => {
                                e.preventDefault()
                                document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                              }}
                            >
                              {h.text}
                            </a>
                          ))}
                          {!filteredHeadings.length && <p className="hint">Нет совпадений</p>}
                        </nav>
                      </aside>
                    ) : null}
                    <article className="prose docs-prose max-w-none">
                      <ReactMarkdown
                        components={{
                          h1: ({ children, ...props }) => {
                            const text = String(children)
                            const id = headings.find((h) => h.level === 1 && h.text === text)?.id ?? slugify(text)
                            return (
                              <h1 id={id} {...props}>
                                {children}
                              </h1>
                            )
                          },
                          h2: ({ children, ...props }) => {
                            const text = String(children)
                            const id = headings.find((h) => h.level === 2 && h.text === text)?.id ?? slugify(text)
                            return (
                              <h2 id={id} {...props}>
                                {children}
                              </h2>
                            )
                          },
                          h3: ({ children, ...props }) => {
                            const text = String(children)
                            const id = headings.find((h) => h.level === 3 && h.text === text)?.id ?? slugify(text)
                            return (
                              <h3 id={id} {...props}>
                                {children}
                              </h3>
                            )
                          },
                        }}
                        remarkPlugins={[remarkGfm]}
                      >
                        {markdown}
                      </ReactMarkdown>
                    </article>
                  </div>
                ) : (
                  <EmptyState description="Выбери файл слева." icon={FileText} title="Нет содержимого" />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
