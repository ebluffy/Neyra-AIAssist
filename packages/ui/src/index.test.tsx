import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, Field, Badge } from './index';
describe('UI primitives', () => {
 it('renders a safe non-submit button', () => { expect(renderToStaticMarkup(<Button disabled>OK</Button>)).toContain('type="button"'); });
 it('associates field and label', () => { const html = renderToStaticMarkup(<Field id="login" label="Логин" required />); expect(html).toContain('for="login"'); expect(html).toContain('id="login"'); });
 it('escapes badge content', () => { expect(renderToStaticMarkup(<Badge>{'<script>'}</Badge>)).toContain('&lt;script&gt;'); });
});
