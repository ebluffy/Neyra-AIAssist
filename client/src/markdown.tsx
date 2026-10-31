import type { ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';

export type Inline =
  | { k: 'text'; v: string }
  | { k: 'code'; v: string }
  | { k: 'strong'; v: string }
  | { k: 'em'; v: string }
  | { k: 'link'; v: string; href: string };

export type Block =
  | { k: 'p'; inlines: Inline[] }
  | { k: 'pre'; lang: string; code: string }
  | { k: 'ul'; items: Inline[][] }
  | { k: 'h'; level: 2 | 3; inlines: Inline[] };

const SAFE_LINK = /^https?:\/\//i;

export function parseInlines(input: string): Inline[] {
  const out: Inline[] = [];
  let rest = input;
  const pushText = (value: string) => { if (value) out.push({ k: 'text', v: value }); };
  while (rest) {
    const code = /^`([^`]+)`/.exec(rest);
    const strong = /^\*\*([^*]+)\*\*/.exec(rest);
    const em = /^\*([^*]+)\*/.exec(rest);
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (code) { out.push({ k: 'code', v: code[1] }); rest = rest.slice(code[0].length); continue; }
    if (strong) { out.push({ k: 'strong', v: strong[1] }); rest = rest.slice(strong[0].length); continue; }
    if (em) { out.push({ k: 'em', v: em[1] }); rest = rest.slice(em[0].length); continue; }
    if (link && SAFE_LINK.test(link[2])) { out.push({ k: 'link', v: link[1], href: link[2] }); rest = rest.slice(link[0].length); continue; }
    if (link) { pushText(link[0]); rest = rest.slice(link[0].length); continue; }
    if (rest[0] === '`' || rest[0] === '*' || rest[0] === '[') { pushText(rest[0]); rest = rest.slice(1); continue; }
    const next = rest.slice(1).search(/[`*[]/);
    const cut = next === -1 ? rest.length : next + 1;
    pushText(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) { body.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1;
      blocks.push({ k: 'pre', lang, code: body.join('\n') });
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    if (/^#{2,3}\s/.test(line)) {
      const level = line.startsWith('###') ? 3 : 2;
      blocks.push({ k: 'h', level, inlines: parseInlines(line.replace(/^#{2,3}\s+/, '')) });
      i += 1;
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(parseInlines(lines[i].replace(/^[-*]\s+/, ''))); i += 1; }
      blocks.push({ k: 'ul', items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !/^#{2,3}\s/.test(lines[i]) && !/^[-*]\s/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ k: 'p', inlines: parseInlines(para.join(' ')) });
  }
  return blocks;
}

function inlineNodes(inlines: Inline[], key: string): ReactNode[] {
  return inlines.map((part, index) => {
    const id = `${key}-${index}`;
    if (part.k === 'code') return <code key={id}>{part.v}</code>;
    if (part.k === 'strong') return <strong key={id}>{part.v}</strong>;
    if (part.k === 'em') return <em key={id}>{part.v}</em>;
    if (part.k === 'link') return <a key={id} href={part.href} onClick={event => { event.preventDefault(); if (SAFE_LINK.test(part.href)) void openUrl(part.href).catch(() => undefined); }}>{part.v}</a>;
    return <span key={id}>{part.v}</span>;
  });
}

function stripSuffix(inlines: Inline[], fresh: string): { inlines: Inline[]; rest: string } {
  const copy = inlines.map(item => ({ ...item }));
  let rest = fresh;
  for (let index = copy.length - 1; index >= 0 && rest; index -= 1) {
    const item = copy[index];
    if (item.k === 'link') break;
    if (rest.endsWith(item.v) && item.v.length > 0) { rest = rest.slice(0, rest.length - item.v.length); copy.splice(index, 1); continue; }
    if (item.v.endsWith(rest)) { item.v = item.v.slice(0, item.v.length - rest.length); rest = ''; }
    else break;
  }
  return { inlines: copy.filter(item => item.k === 'link' || item.v.length > 0), rest };
}

export function Markdown({ text, fresh = '', onCopy }: { text: string; fresh?: string; onCopy?: (value: string) => void }) {
  const blocks = parseMarkdown(text);
  const head = fresh && text.endsWith(fresh) ? text.slice(0, text.length - fresh.length) : text;
  const headBlocks = fresh ? parseMarkdown(head) : blocks;
  const sameShape = Boolean(fresh) && headBlocks.length === blocks.length && headBlocks.every((block, index) => block.k === blocks[index].k);
  const shown = blocks;
  const blockNode = (block: Block, index: number, tail: string) => {
    if (block.k === 'pre') {
      const kept = tail && block.code.endsWith(tail) ? block.code.slice(0, -tail.length) : block.code;
      const arriving = tail && block.code.endsWith(tail) ? tail : '';
      return <div className="codeblock" key={index}><pre><code>{kept}{arriving && <span className="arriving">{arriving}</span>}</code></pre>{onCopy && <button type="button" aria-label="Копировать код" data-tip="Копировать код" onClick={() => onCopy(block.code)}><Copy size={15} strokeWidth={1.75} aria-hidden="true" /></button>}</div>;
    }
    if (block.k === 'ul') {
      const items = block.items.map(item => [...item]);
      let arriving = '';
      if (tail && items.length > 0) {
        const stripped = stripSuffix(items[items.length - 1], tail);
        if (!stripped.rest) { items[items.length - 1] = stripped.inlines; arriving = tail; }
      }
      return <ul key={index}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineNodes(item, `${index}-${itemIndex}`)}{arriving && itemIndex === items.length - 1 && <span className="arriving">{arriving}</span>}</li>)}</ul>;
    }
    if (block.k === 'h') {
      const Tag = block.level === 2 ? 'h2' : 'h3';
      const stripped = tail ? stripSuffix(block.inlines, tail) : { inlines: block.inlines, rest: tail };
      const arriving = tail && !stripped.rest ? tail : '';
      return <Tag key={index}>{inlineNodes(stripped.rest ? block.inlines : stripped.inlines, String(index))}{arriving && <span className="arriving">{arriving}</span>}</Tag>;
    }
    const stripped = tail ? stripSuffix(block.inlines, tail) : { inlines: block.inlines, rest: tail };
    const arriving = tail && !stripped.rest ? tail : '';
    return <p key={index}>{inlineNodes(stripped.rest ? block.inlines : stripped.inlines, String(index))}{arriving && <span className="arriving">{arriving}</span>}</p>;
  };
  if (blocks.length === 0 && text) return <p className="plain">{text}</p>;
  return <div className="md">{shown.map((block, index) => blockNode(block, index, sameShape && index === shown.length - 1 ? fresh : ''))}</div>;
}
