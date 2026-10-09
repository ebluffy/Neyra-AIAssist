import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { BookOpenText, ExternalLink, FileText } from 'lucide-react'
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

export function DocsScreen() {
  const [sections, setSections] = useState<DocSection[]>([])
  const [tab, setTab] = useState('')
  const [docId, setDocId] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [error, setError] = useState('')
  const [loadingCat, setLoadingCat] = useState(true)
  const [loadingDoc, setLoadingDoc] = useState(false)

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

  useEffect(() => {
    if (!docId) return
    let cancelled = false
    ;(async () => {
      setLoadingDoc(true)
      setError('')
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
      <PageHeader title="Документация" subtitle="Markdown из репозитория и ссылки на OpenAPI" />

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
                  <article className="prose prose-zinc prose-invert max-w-none docs-prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
                  </article>
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
