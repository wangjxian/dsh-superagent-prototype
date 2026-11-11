/** The yunxiao rich-text converter: the HTML and jsonML a work item's description and comments arrive in, as Markdown. */
import { expect, it } from 'vitest'
import { richText } from '../src/sources/yunxiao-text.ts'

it('converts the inline and block markup a rich-text editor writes', () => {
  expect(richText('<p>Hello <strong>world</strong> and <em>you</em></p>')).toBe('Hello **world** and *you*')
  expect(richText('<p>a<br>b</p>')).toBe('a\nb')
  expect(richText('<p>run <code>pnpm test</code></p>')).toBe('run `pnpm test`')
  expect(richText('<p>see <a href="https://example.com/x">the log</a></p>')).toBe('see [the log](https://example.com/x)')
  expect(richText('<p><img src="https://example.com/a.png" alt="screenshot"></p>')).toBe('![screenshot](https://example.com/a.png)')
  expect(richText('<h1>One</h1><h2>Two</h2><h3>Three</h3>')).toBe('# One\n\n## Two\n\n### Three')
  expect(richText('<blockquote><p>quoted</p></blockquote>')).toBe('> quoted')
  expect(richText('<p>one</p><p>two</p>')).toBe('one\n\ntwo')
})
it('renders lists, including a nested one indented under its item', () => {
  expect(richText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two')
  expect(richText('<ol><li>first</li><li>second</li></ol>')).toBe('1. first\n2. second')
  expect(richText('<ul><li>one<ul><li>deep</li></ul></li></ul>')).toBe('- one\n  - deep')
})
it('fences code blocks with their language and keeps the code itself untouched', () => {
  const markdown = richText('<pre><code class="language-ts">const a = 1\n\n\nconst b = 2</code></pre>')
  expect(markdown).toBe('```ts\nconst a = 1\n\n\nconst b = 2\n```')
  expect(richText('<pre>plain\nblock</pre>')).toBe('```\nplain\nblock\n```')
})
it('decodes character references, including numeric ones', () => {
  expect(richText('<p>a &amp; b &lt;c&gt; &#39;d&#39;&nbsp;e</p>')).toBe("a & b <c> 'd' e")
  expect(richText('&#x2713; &#65;')).toBe('\u2713 A')
  // An unknown reference stays as the editor wrote it rather than becoming a character nobody meant.
  expect(richText('&nosuchentity;')).toBe('&nosuchentity;')
})
it('keeps the text of tags it does not model', () => {
  expect(richText('<p><span style="color:red">colored</span> and <custom-tag>kept</custom-tag></p>')).toBe('colored and kept')
  expect(richText('<table><tr><td>cell</td></tr></table>')).toBe('cell')
})
it('converts jsonML, both as an array and as the JSON string the API may store', () => {
  expect(richText(['p', { style: 'margin:0' }, 'Hello ', ['strong', 'world']])).toBe('Hello **world**')
  expect(richText(['ul', ['li', 'one'], ['li', 'two']])).toBe('- one\n- two')
  expect(richText(['#text', 'bare text'])).toBe('bare text')
  expect(richText('["p","stored as JSON"]')).toBe('stored as JSON')
})
it('passes plain text through, and reads nothing out of an absent value', () => {
  expect(richText('just text')).toBe('just text')
  expect(richText('3 < 4 and 5 > 2')).toBe('3 < 4 and 5 > 2')
  expect(richText({ html: '<p>wrapped</p>' })).toBe('wrapped')
  expect(richText(null)).toBe('')
  expect(richText(undefined)).toBe('')
  expect(richText({})).toBe('')
})
it('reads the JSON-string wrapper the current work-item and review editors return', () => {
  const value = { htmlValue: '<p>QA <strong>passed</strong></p>', jsonMLValue: ['p', {}, 'QA passed'] }
  expect(richText(JSON.stringify(value))).toBe('QA **passed**')
  expect(richText(value)).toBe('QA **passed**')
  expect(richText(JSON.stringify({ jsonMLValue: ['p', {}, 'QA passed'] }))).toBe('QA passed')
  expect(richText('{"price":1}')).toBe('{"price":1}')
})
it('tolerates markup a parser would reject, without losing the readable text', () => {
  expect(richText('<p>unclosed')).toBe('unclosed')
  expect(richText('<p>a</div>b</p>')).toBe('ab')
  expect(richText('<p>a < b</p>')).toBe('a < b')
  expect(richText('<p>text</p> trailing <p>more</p>')).toBe('text\n\ntrailing\n\nmore')
})
