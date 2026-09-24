// Minimal, safe markdown for answers. Loaded by the renderer as a plain
// script (window.CueMarkdown) and by the Node tests (module.exports).
(function (root) {
  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // Minimal, safe markdown: everything is escaped first, and only a fixed set
  // of tags is produced (no links or raw HTML). Handles fenced code (with a
  // language label and copy button), bullet and numbered lists, headings,
  // inline code, bold and italics. Safe to call on a partial answer while it
  // streams: an unclosed fence or list is closed at the end.
  function inlineMarkdown(s) {
    // Split on inline code first so emphasis never applies inside code.
    return s.split(/(`[^`]+`)/).map((part) => {
      if (/^`[^`]+`$/.test(part)) return '<code>' + esc(part.slice(1, -1)) + '</code>';
      return esc(part)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    }).join('');
  }

  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, list = null, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inlineMarkdown(buf.join(' ')) + '</p>'; buf = []; } };
    const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
    const openList = (type) => { if (list !== type) { closeList(); html += '<' + type + '>'; list = type; } };
    for (const line of lines) {
      const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
      if (fence) {
        if (!inCode) {
          flushP(); closeList();
          const lang = fence[1] ? '<span class="code-lang">' + esc(fence[1]) + '</span>' : '<span class="code-lang"></span>';
          html += '<div class="code-block"><div class="code-head">' + lang + '<button class="copy-code" type="button">Copy</button></div><pre><code>';
          inCode = true;
        } else { html += '</code></pre></div>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (heading) { flushP(); closeList(); html += '<p class="md-h">' + inlineMarkdown(heading[1]) + '</p>'; continue; }
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      if (bullet) { flushP(); openList('ul'); html += '<li>' + inlineMarkdown(bullet[1]) + '</li>'; continue; }
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (numbered) { flushP(); openList('ol'); html += '<li>' + inlineMarkdown(numbered[1]) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); closeList(); continue; }
      closeList();
      buf.push(line.trim());
    }
    flushP(); closeList(); if (inCode) html += '</code></pre></div>';
    return html;
  }

  const api = { renderMarkdown, inlineMarkdown };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CueMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
