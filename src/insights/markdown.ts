/**
 * Tiny, safe Markdown-to-HTML renderer for LLM coach output.
 *
 * LLM output is untrusted, so the input is HTML-escaped FIRST, then a minimal
 * Markdown subset is applied (headings, bold, italic, inline code, unordered
 * and ordered lists, paragraphs). No raw HTML from the model is ever emitted,
 * so this cannot inject scripts or arbitrary markup.
 */

/** Escape the five HTML-significant characters. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Apply inline formatting (bold, italic, code) to already-escaped text. */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg-3); padding:1px 5px; border-radius:4px;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

/**
 * Render a small Markdown subset to safe HTML. Supports:
 * `#`/`##`/`###` headings, `-`/`*` bullet lists, `1.` ordered lists, blank-line
 * separated paragraphs, and inline **bold**, *italic*, `code`.
 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeList = (): void => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const escaped = escapeHtml(line.trim());

    if (line.trim() === '') { closeList(); continue; }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line.trim());
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      const size = level === 1 ? '1.05rem' : level === 2 ? '0.92rem' : '0.82rem';
      const text = inline(escapeHtml(heading[2]!));
      html.push(`<div style="font-weight:700; font-size:${size}; color:var(--accent); margin:10px 0 4px;">${text}</div>`);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line.trim());
    if (bullet) {
      if (listType !== 'ul') { closeList(); html.push('<ul style="margin:4px 0 4px 18px; display:flex; flex-direction:column; gap:3px;">'); listType = 'ul'; }
      html.push(`<li>${inline(escapeHtml(bullet[1]!))}</li>`);
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line.trim());
    if (ordered) {
      if (listType !== 'ol') { closeList(); html.push('<ol style="margin:4px 0 4px 20px; display:flex; flex-direction:column; gap:3px;">'); listType = 'ol'; }
      html.push(`<li>${inline(escapeHtml(ordered[1]!))}</li>`);
      continue;
    }

    closeList();
    html.push(`<p style="margin:6px 0;">${inline(escaped)}</p>`);
  }
  closeList();
  return html.join('');
}
