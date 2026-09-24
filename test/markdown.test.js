const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('../renderer/markdown');

test('escapes HTML everywhere, including code', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> and `<b>`\n```\n<script>x</script>\n```');
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test('numbered and bullet lists, headings, bold and italics', () => {
  const html = renderMarkdown('## Approach\n1. Sort the *array*\n2. Two **pointers**\n\n- done');
  assert.match(html, /<p class="md-h">Approach<\/p>/);
  assert.match(html, /<ol><li>Sort the <em>array<\/em><\/li><li>Two <strong>pointers<\/strong><\/li><\/ol>/);
  assert.match(html, /<ul><li>done<\/li><\/ul>/);
});

test('emphasis never applies inside inline code or to arithmetic', () => {
  assert.match(renderMarkdown('use `a*b*c` here'), /<code>a\*b\*c<\/code>/);
  assert.doesNotMatch(renderMarkdown('O(n*m) and 2*3*4'), /<em>/);
  assert.doesNotMatch(renderMarkdown('snake_case_name'), /<em>/);
});

test('code blocks carry their language and a copy button', () => {
  const html = renderMarkdown('```python\nreturn x < 2\n```');
  assert.match(html, /<span class="code-lang">python<\/span><button class="copy-code"/);
  assert.match(html, /<pre><code>return x &lt; 2\n<\/code><\/pre>/);
});

test('a partial answer renders cleanly while it streams', () => {
  const html = renderMarkdown('Approach:\n```js\nfunction f() {\n  return 1;');
  assert.match(html, /<\/code><\/pre><\/div>$/, 'unclosed fence is closed');
  assert.equal((html.match(/<div class="code-block">/g) || []).length, 1);
  assert.match(renderMarkdown('1. first\n2. sec'), /<\/ol>$/);
});

test('quoted lines form one block per paragraph', () => {
  assert.equal(renderMarkdown('> a\n> *b*\n\n> c'), '<blockquote>a<br><em>b</em></blockquote><blockquote>c</blockquote>');
});
