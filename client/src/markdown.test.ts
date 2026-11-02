import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseInlines, parseMarkdown } from './markdown';

describe('markdown', () => {
  it('keeps prose, emphasis and inline code as text nodes', () => {
    expect(parseInlines('см. **код** и `a`')).toEqual([
      { k: 'text', v: 'см. ' },
      { k: 'strong', v: 'код' },
      { k: 'text', v: ' и ' },
      { k: 'code', v: 'a' },
    ]);
  });
  it('allows only http links', () => {
    const parts = parseInlines('[сайт](https://example.com) [x](javascript:alert(1))');
    expect(parts[0]).toEqual({ k: 'link', v: 'сайт', href: 'https://example.com' });
    expect(parts.some(part => part.k === 'link' && part.href.startsWith('javascript:'))).toBe(false);
  });
  it('closes an unfinished fence as code', () => {
    const blocks = parseMarkdown('привет\n```ts\nconst n = 1');
    expect(blocks[0]).toMatchObject({ k: 'p' });
    expect(blocks[1]).toEqual({ k: 'pre', lang: 'ts', code: 'const n = 1' });
  });
  it('keeps a fresh tail inside the last paragraph', () => {
    const html = renderToStaticMarkup(Markdown({ text: 'Собираю пункты ещё', fresh: ' ещё' }));
    expect(html.match(/<p>/g)).toHaveLength(1);
    expect(html.indexOf('<span class="arriving">')).toBeGreaterThan(html.indexOf('<p>'));
    expect(html.indexOf('arriving')).toBeLessThan(html.indexOf('</p>'));
    expect(html).toContain('Собираю пункты');
    expect(html).toContain('ещё');
  });
  it('keeps a reshaped list instead of the stale draft', () => {
    const html = renderToStaticMarkup(Markdown({ text: '- a\n- b', fresh: ' b' }));
    expect(html).toContain('b');
    expect(html).not.toContain('<p>-</p>');
    expect(html).not.toContain('<p>');
  });
  it('groups list items', () => {
    expect(parseMarkdown('- один\n- два')).toEqual([{ k: 'ul', items: [[{ k: 'text', v: 'один' }], [{ k: 'text', v: 'два' }]] }]);
  });
});
