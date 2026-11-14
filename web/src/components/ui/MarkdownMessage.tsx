'use client';

import React, { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ children, className = '' }: { children: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);

  // Extract raw text from children for clipboard copy
  const extractText = (node: ReactNode): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(extractText).join('');
    if (node && typeof node === 'object' && 'props' in node && (node as { props: { children?: ReactNode } }).props?.children) {
      return extractText((node as { props: { children: ReactNode } }).props.children);
    }
    return '';
  };

  const handleCopy = async () => {
    const text = extractText(children).replace(/\n$/, '');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // Ignore clipboard write failures
    }
  };

  return (
    <div className="relative group my-3">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Скопировано' : 'Скопировать код'}
        className="absolute top-2.5 right-2.5 z-10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--border)] text-xs flex items-center gap-1 cursor-pointer"
      >
        {copied ? <Check size={13} className="text-[var(--success)]" /> : <Copy size={13} />}
        <span className="text-[11px]">{copied ? 'Скопировано' : 'Копировать'}</span>
      </button>
      <pre className="overflow-x-auto rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] p-4 text-[13px] leading-relaxed font-mono text-[var(--text)]">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="text-[15px] leading-[24px] text-[var(--text)] space-y-3 break-words [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-[18px] font-semibold text-[var(--text)] mt-4 mb-2 tracking-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[16px] font-semibold text-[var(--text)] mt-3 mb-1.5 tracking-tight">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[15px] font-semibold text-[var(--text)] mt-2.5 mb-1">{children}</h3>,
          p: ({ children }) => <p className="mb-2.5 last:mb-0 leading-[24px]">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-[22px]">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] underline underline-offset-[3px] hover:opacity-80 transition-opacity"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[var(--accent)] pl-3 my-2 text-[var(--text-muted)] italic">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border-collapse border border-[var(--border)] text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left font-medium text-[var(--text)]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[var(--border)] px-3 py-2 text-[var(--text)]">{children}</td>
          ),
          code({ className, children, ...props }) {
            const isInline = !className && typeof children === 'string' && !children.includes('\n');
            if (isInline) {
              return (
                <code
                  className="rounded-[4px] bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[13px] text-[var(--text)]"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          pre({ children }) {
            // Handled directly inside code component to avoid nested pre tags
            return <>{children}</>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
