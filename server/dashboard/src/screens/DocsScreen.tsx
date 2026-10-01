import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { BookOpenText, ExternalLink, FileText } from 'lucide-react'
import remarkGfm from 'remark-gfm'
import { apiGetText } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

type DocKey = 'readme-ru' | 'readme-en' | 'help-ru' | 'help-en' | 'docs-ru-index' | 'docs-en-index'

const DOC_OPTIONS: Array<{ key: DocKey; label: string }> = [
  { key: 'readme-ru', label: 'README-RU' },
  { key: 'readme-en', label: 'README-EN' },
  { key: 'help-ru', label: 'HELP-RU' },
  { key: 'help-en', label: 'HELP-EN' },
  { key: 'docs-ru-index', label: 'DOCS RU' },
  { key: 'docs-en-index', label: 'DOCS EN' },
]

export function DocsScreen() {
  const [doc, setDoc] = useState<DocKey>('readme-ru')
  const [markdown, setMarkdown] = useState('Загрузка...')
  const [error, setError] = useState('')
  const [loadingDoc, setLoadingDoc] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadDoc() {
      setError('')
      setLoadingDoc(true)
      try {
        const text = await apiGetText(`/v1/docs/markdown/${doc}`)
        if (!cancelled) setMarkdown(text)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setMarkdown('')
        }
      } finally {
        if (!cancelled) setLoadingDoc(false)
      }
    }
    void loadDoc()
    return () => {
      cancelled = true
    }
  }, [doc])

  return (
    <div className="page-content stack">
      <PageHeader title="API Docs" subtitle="OpenAPI / Swagger и Markdown из репозитория" />

      <div className="card">
        <div className="card-header">
          <BookOpenText size={15} className="card-icon card-icon-cyan" />
          <span className="card-title">OpenAPI</span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
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
              {label} <ExternalLink size={12} />
            </a>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <FileText size={15} className="card-icon" />
          <span className="card-title">Markdown</span>
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
          </div>
        ) : markdown ? (
          <article
            className="prose prose-zinc prose-invert max-w-none"
            style={{ background: 'rgba(5,5,10,0.5)', border: '1px solid var(--border)', borderRadius: 10, padding: '1rem 1.25rem' }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </article>
        ) : (
          <EmptyState description="Проверь /v1/docs/markdown/*" icon={FileText} title="Документация недоступна" />
        )}
      </div>
    </div>
  )
}
