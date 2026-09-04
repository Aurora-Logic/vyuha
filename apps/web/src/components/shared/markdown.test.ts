import { describe, expect, it } from 'vitest';

import { escapeHtml, renderMarkdown } from './markdown';

/**
 * This output is handed to dangerouslySetInnerHTML, so the tests that matter
 * are the hostile ones: everything a person could type that wants to become
 * markup. The renderer's whole safety argument is that input is escaped
 * before any tag exists, so these assert that no input survives as a tag.
 */
describe('renderMarkdown, attacked first', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="evil"></iframe>',
    '"><svg onload=alert(1)>',
    "'; DROP TABLE deals; --",
    '<a href="javascript:alert(1)">click</a>',
  ];

  const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'code', 'a', 'ul', 'ol', 'li', 'h3', 'h4', 'h5'];
  const tagsIn = (html: string) => [...html.matchAll(/<\/?([a-z0-9]+)/giu)].map((m) => (m[1] ?? '').toLowerCase());

  it.each(attacks)('never lets %s become markup', (attack) => {
    const html = renderMarkdown(attack);
    // Every tag in the output is one this renderer wrote itself.
    expect(tagsIn(html).filter((tag) => !ALLOWED_TAGS.includes(tag))).toEqual([]);
    // And the angle brackets the writer typed survive as visible text.
    if (attack.includes('<')) expect(html).toContain('&lt;');
  });

  it('refuses a javascript: or data: link target, keeping it as plain text', () => {
    expect(renderMarkdown('[click](javascript:alert(1))')).not.toContain('<a ');
    expect(renderMarkdown('[click](data:text/html;base64,PHN2Zz4=)')).not.toContain('<a ');
    expect(renderMarkdown('[docs](https://example.com/a)')).toContain('<a href="https://example.com/a"');
    expect(renderMarkdown('[mail](mailto:a@b.com)')).toContain('<a href="mailto:a@b.com"');
  });

  it('opens external links safely', () => {
    expect(renderMarkdown('[x](https://a.test)')).toContain('rel="noopener noreferrer"');
  });

  it('escapes ampersands and quotes without double-escaping into nonsense', () => {
    expect(escapeHtml('Tata & Sons "quoted"')).toBe('Tata &amp; Sons &quot;quoted&quot;');
  });
});

describe('renderMarkdown, the marks a sales note uses', () => {
  it('renders headings, bold, italic and inline code', () => {
    expect(renderMarkdown('## Site visit')).toBe('<h4>Site visit</h4>');
    expect(renderMarkdown('**urgent**')).toBe('<p><strong>urgent</strong></p>');
    expect(renderMarkdown('*maybe*')).toBe('<p><em>maybe</em></p>');
    expect(renderMarkdown('use `MCCB-63A`')).toBe('<p>use <code>MCCB-63A</code></p>');
  });

  it('does not read markdown inside code', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  it('groups bullets and numbers into one list each', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  it('keeps a blank line as a paragraph break and a single break as a line break', () => {
    expect(renderMarkdown('a\nb')).toBe('<p>a<br />b</p>');
    expect(renderMarkdown('a\n\nb')).toBe('<p>a</p><p>b</p>');
  });

  it('renders nothing for nothing', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });
});
