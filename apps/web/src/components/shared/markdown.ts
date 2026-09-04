/**
 * A deliberately small markdown renderer (owner, 31 Aug 2026: rich notes
 * without a dependency).
 *
 * The safety argument is the order of operations, not a filter: every
 * character of input is HTML-escaped FIRST, so nothing the writer typed can
 * ever become a tag. Only afterwards does this function introduce tags of its
 * own, from a fixed set it writes itself. There is no path by which input
 * reaches the output as markup, which is why no sanitiser is needed and why
 * `dangerouslySetInnerHTML` is honest here rather than reckless.
 *
 * What it supports is what a sales note actually uses: headings, bold,
 * italic, inline code, links, bullet and numbered lists, and paragraphs.
 * Everything else stays literal text. A link's href is restricted to http,
 * https and mailto -- `javascript:` and `data:` are rendered as plain text,
 * because an escaped-but-linked URL is still a live click.
 */

/**
 * A private-use code point stands in for a code span while the other marks
 * run. It cannot occur in the escaped input for the same reason a NUL could
 * not: nothing upstream produces it.
 */
const SENTINEL = '\uE000';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (ch) => ESCAPES[ch] ?? ch);
}

/** http, https and mailto only; anything else is not made clickable. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(https?:\/\/|mailto:)[^\s<>"']+$/iu.test(trimmed) ? trimmed : null;
}

/**
 * Inline marks, applied to already-escaped text.
 *
 * Code spans are lifted out before the other marks run and put back after.
 * Replacing them in place was not enough: the bold pass still found the
 * asterisks inside the emitted <code>, so `**not bold**` came back bold.
 */
function inline(escaped: string): string {
  const codes: string[] = [];
  const withoutCode = escaped.replace(/`([^`]+)`/gu, (_whole, code: string) => {
    codes.push(code);
    return `${SENTINEL}${String(codes.length - 1)}${SENTINEL}`;
  });
  const marked = withoutCode
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (whole, label: string, href: string) => {
      const safe = safeHref(href);
      return safe === null ? whole : `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/gu, '$1<em>$2</em>');
  return marked.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'gu'), (_whole, index: string) => `<code>${codes[Number(index)] ?? ''}</code>`);
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).split(/\r?\n/u);
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join('<br />'))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list !== null) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)$/u.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/u.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);

    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1]?.length ?? 1;
      out.push(`<h${String(level + 2)}>${inline(heading[2] ?? '')}</h${String(level + 2)}>`);
      continue;
    }
    if (bullet ?? numbered) {
      closeParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (list !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        list = wanted;
      }
      out.push(`<li>${inline((bullet ?? numbered)?.[1] ?? '')}</li>`);
      continue;
    }
    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  closeParagraph();
  closeList();
  return out.join('');
}
