import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { BookOpenText, ExternalLink, FileText } from 'lucide-react'
import remarkGfm from 'remark-gfm'
import { apiGetText } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { Skeleton } from '../components/ui/skeleton'

type DocKey = 'readme-ru' | 'readme-en' | 'help-ru' | 'help-en' | 'docs-ru-index' | 'docs-en-index'

const DOC_OPTIONS: Array<{ key: DocKey; label: string }> = [
  { key: 'readme-ru',     label: 'README-RU' },
  { key: 'readme-en',     label: 'README-EN' },
  { key: 'help-ru',       label: 'HELP-RU' },
  { key: 'help-en',       label: 'HELP-EN' },
  { key: 'docs-ru-index', label: 'DOCS RU' },
  { key: 'docs-en-index', label: 'DOCS EN' },
]

export function DocsPage() {
  const [doc, setDoc] = useState<DocKey>('readme-ru')
  const [markdown, setMarkdown] = useState<string>('Загрузка...')
  const [error, setError] = useState<string>('')
  const [loadingDoc, setLoadingDoc] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadDoc() {
      setError(''); setLoadingDoc(true)
      try {
        const text = await apiGetText(`/v1/docs/markdown/${doc}`)
        if (!cancelled) setMarkdown(text)
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setMarkdown('') }
      } finally { if (!cancelled) setLoadingDoc(false) }
    }
    void loadDoc()
    return () => { cancelled = true }
  }, [doc])

  return (
    <div className="page-content stack">
      <div className="page-header">
        <h1 className="page-title">API Документация</h1>
        <p className="page-sub">Swagger UI, OpenAPI JSON и Markdown документы</p>
      </div>

      {/* Swagger + links */}
      <div className="card">
        <div className="card-header">
          <BookOpenText size={15} className="card-icon card-icon-cyan" />
          <span className="card-title">Swagger / OpenAPI</span>
        </div>
        <div className="row" style={{ marginBottom: '1rem' }}>
          <a
            className="btn btn-secondary btn-sm"
            href="/openapi.json"
            rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
            target="_blank"
          >
            OpenAPI JSON <ExternalLink size={12} />
          </a>
        </div>
        <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)', background: '#fff' }}>
          <iframe
            className="docs-frame"
            src="/docs"
            style={{ minHeight: 560, border: 'none', display: 'block' }}
            title="Neyra API docs"
          />
        </div>
      </div>

      {/* Markdown docs */}
      <div className="card">
        <div className="card-header">
          <FileText size={15} className="card-icon" />
          <span className="card-title">Markdown документация</span>
        </div>
        <div className="row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
          {DOC_OPTIONS.map((o) => (
            <Button key={o.key} onClick={() => setDoc(o.key)} size="sm" variant={doc === o.key ? 'default' : 'secondary'}>
              {o.label}
            </Button>
          ))}
        </div>
        {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
        {loadingDoc ? (
          <div className="stack-sm">
            <Skeleton style={{ height: 22, width: '40%' }} />
            <Skeleton style={{ height: 16, width: '100%' }} />
            <Skeleton style={{ height: 16, width: '92%' }} />
            <Skeleton style={{ height: 80, width: '100%' }} />
          </div>
        ) : markdown ? (
          <article className="prose prose-zinc prose-invert max-w-none prose-headings:tracking-tight prose-headings:text-zinc-100 prose-p:leading-7 prose-p:text-zinc-300 prose-li:text-zinc-300 prose-code:text-cyan-300 prose-pre:bg-zinc-900/90"
            style={{ background: 'rgba(5,5,10,0.5)', border: '1px solid var(--border)', borderRadius: 10, padding: '1rem 1.25rem' }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </article>
        ) : (
          <EmptyState
            description="Проверь /v1/docs/markdown/* или выбери другой раздел."
            icon={FileText}
            title="Документация недоступна"
          />
        )}
      </div>
    </div>
  )
}
