/** Converts yunxiao rich text — HTML, jsonML, or plain text — into Markdown for prompts and context reads. */

/**
 * A parsed rich-text node: an element with its attributes and children, or a run of text.
 * Both input encodings (HTML and jsonML) normalize into this one shape so the Markdown rules are written once.
 */
interface ElementNode { tag: string; attrs: Record<string, string>; children: RichNode[] }
interface TextNode { text: string }
type RichNode = ElementNode | TextNode

const isElement = (node: RichNode): node is ElementNode => 'tag' in node
/** HTML elements that never have children or a closing tag. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
/** Named character references the editor emits; a name outside this table is left as written, so nothing is invented. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', times: '×', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', laquo: '«', raquo: '»',
}
/** Decodes the character references a rich-text editor emits; an unknown name stays as it was written. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole
  })
}
/** Whether `input` carries markup, told apart from plain text that merely contains `<` or `>`. */
const HTML_TAG = /<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/
/** Attributes of one HTML start tag: bare names, and values in double quotes, single quotes, or unquoted. */
function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of text.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}
/**
 * Parses HTML into nodes with a stack rather than a full parser: rich-text editors emit well-nested markup, and a
 * stray closing tag only pops what it matches. Comments and doctypes are dropped, as they carry no readable text.
 */
function htmlTree(html: string): RichNode[] {
  const root: ElementNode = { tag: '#root', attrs: {}, children: [] }
  const open: ElementNode[] = [root]
  const push = (node: RichNode) => { open.at(-1)!.children.push(node) }
  const pushText = (text: string) => { if (text) push({ text: decodeEntities(text) }) }
  let index = 0
  while (index < html.length) {
    const start = html.indexOf('<', index)
    if (start < 0) { pushText(html.slice(index)); break }
    if (start > index) pushText(html.slice(index, start))
    const rest = html.slice(start)
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->')
      index = end < 0 ? html.length : start + end + 3
      continue
    }
    // A doctype or processing instruction carries no readable text.
    if (/^<[!?]/.test(rest)) {
      const end = rest.indexOf('>')
      index = end < 0 ? html.length : start + end + 1
      continue
    }
    // A tag name follows `<` immediately; anything else is a literal `<` in the text, kept and scanned past.
    const parsed = /^<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/.exec(rest)
    if (!parsed) { pushText('<'); index = start + 1; continue }
    index = start + parsed[0].length
    const [, closing, name, attrText = '', selfClosing] = parsed
    const tag = name!.toLowerCase()
    if (closing) {
      const at = open.map(node => node.tag).lastIndexOf(tag)
      if (at > 0) open.length = at
      continue
    }
    const element: ElementNode = { tag, attrs: attributes(attrText), children: [] }
    push(element)
    if (!selfClosing && !VOID.has(tag)) open.push(element)
  }
  return root.children
}
/**
 * Parses jsonML (`["p", {style}, "text", ["strong", "bold"]]`) into the same nodes; the optional second element is the
 * attribute object, and a string child is text.
 */
function jsonmlTree(value: unknown): RichNode[] {
  if (typeof value === 'string') return [{ text: decodeEntities(value) }]
  if (typeof value === 'number' || typeof value === 'boolean') return [{ text: String(value) }]
  if (!Array.isArray(value)) return []
  const [head, ...rest] = value
  // A fragment without a tag name is not jsonML; keep the text of its children.
  if (typeof head !== 'string') return rest.flatMap(jsonmlTree)
  if (head.toLowerCase() === '#text') return [{ text: rest.map(item => typeof item === 'string' ? decodeEntities(item) : String(item)).join('') }]
  const second = rest[0]
  const hasAttrs = second !== null && typeof second === 'object' && !Array.isArray(second)
  const attrs = hasAttrs
    ? Object.fromEntries(Object.entries(second as Record<string, unknown>).map(([name, item]) => [name.toLowerCase(), item == null ? '' : String(item)]))
    : {}
  return [{ tag: head.toLowerCase(), attrs, children: (hasAttrs ? rest.slice(1) : rest).flatMap(jsonmlTree) }]
}
/** The text of `nodes` without any Markdown markup, for inline code and code blocks. */
function plainText(nodes: RichNode[]): string {
  return nodes.map(node => isElement(node) ? (node.tag === 'br' ? '\n' : plainText(node.children)) : node.text).join('')
}
/** The code language of `node`, which editors write as `class="language-<lang>"` or a `lang` attribute. */
function languageOf(node: ElementNode | undefined): string {
  const named = /(?:^|\s)language-([\w+#.-]+)/.exec(node?.attrs.class ?? '')
  return named?.[1] ?? node?.attrs.lang ?? node?.attrs['data-lang'] ?? ''
}
function emphasis(marker: string, node: ElementNode, depth: number): string {
  const text = renderNodes(node.children, depth).trim()
  return text ? `${marker}${text}${marker}` : ''
}
function codeSpan(node: ElementNode): string {
  const text = plainText(node.children)
  if (!text) return ''
  // A body that itself contains a backtick needs the longer fence to stay one span.
  const fence = text.includes('`') ? '``' : '`'
  return `${fence}${text}${fence}`
}
function codeBlock(node: ElementNode): string {
  const code = node.children.find((child): child is ElementNode => isElement(child) && child.tag === 'code')
  const language = languageOf(node) || languageOf(code)
  const text = plainText((code ?? node).children).replace(/^\n+|\n+$/g, '')
  return `\`\`\`${language}\n${text}\n\`\`\``
}
/** Renders a list, indenting a nested list under its item; `depth` is how many levels of it the list is under. */
function list(node: ElementNode, ordered: boolean, depth: number): string {
  const indent = '  '.repeat(depth)
  const items = node.children.filter((child): child is ElementNode => isElement(child) && child.tag === 'li')
  const rendered = items.map((item, index) => {
    const nested = item.children.filter((child): child is ElementNode => isElement(child) && (child.tag === 'ul' || child.tag === 'ol'))
    // The item's own text renders here; a nested list is rendered below it, one level deeper.
    const own = item.children.filter(child => !isElement(child) || (child.tag !== 'ul' && child.tag !== 'ol'))
    const body = renderNodes(own, depth).trim().replace(/\n{2,}/g, '\n')
    const marker = ordered ? `${index + 1}. ` : '- '
    const head = `${indent}${marker}${body.replace(/\n/g, `\n${indent}  `)}`.trimEnd()
    const below = nested.map(child => list(child, child.tag === 'ol', depth + 1)).join('')
    return `${head}\n${below}`
  })
  return rendered.join('')
}
function quote(inner: string): string {
  const text = inner.trim()
  if (!text) return ''
  return text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n')
}
function anchor(node: ElementNode, depth: number): string {
  const href = node.attrs.href ?? node.attrs['data-href'] ?? ''
  const text = renderNodes(node.children, depth).trim()
  if (!text) return href
  return !href || href === text ? text : `[${text}](${href})`
}
function image(node: ElementNode): string {
  const src = node.attrs.src ?? node.attrs['data-src'] ?? ''
  if (!src) return ''
  return `![${node.attrs.alt ?? node.attrs.title ?? ''}](${src})`
}
/** Tags that start their own block, so the text before and after them is separated by a blank line. */
const BLOCK = new Set(['p', 'div', 'section', 'article', 'figure', 'figcaption', 'header', 'footer', 'pre', 'blockquote',
  'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'])
/** Renders one element without its block separation; a tag this module does not model keeps its children's text. */
function renderNode(node: ElementNode, depth: number): string {
  const children = () => renderNodes(node.children, depth)
  switch (node.tag) {
    case 'p': case 'div': case 'section': case 'article': case 'figure': case 'figcaption': case 'header': case 'footer':
      return children()
    case 'br': return '\n'
    case 'hr': return '---'
    case 'strong': case 'b': return emphasis('**', node, depth)
    case 'em': case 'i': return emphasis('*', node, depth)
    case 'del': case 's': case 'strike': return emphasis('~~', node, depth)
    case 'code': return codeSpan(node)
    case 'pre': return codeBlock(node)
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return `${'#'.repeat(Math.min(Number(node.tag.slice(1)), 3))} ${children().trim()}`
    case 'ul': return list(node, false, depth)
    case 'ol': return list(node, true, depth)
    case 'li': return `${children().trim()}\n`
    case 'blockquote': return quote(children())
    case 'a': return anchor(node, depth)
    case 'img': return image(node)
    default: return children()
  }
}
/** Renders nodes as Markdown; a block element is separated from its neighbours by a blank line. */
function renderNodes(nodes: RichNode[], depth: number): string {
  return nodes.map(node => {
    if (!isElement(node)) return node.text
    const text = renderNode(node, depth)
    return BLOCK.has(node.tag) ? `\n\n${text}\n\n` : text
  }).join('')
}
/** Collapses the whitespace an editor's markup leaves behind, except inside fenced code, where it is content. */
function tidy(markdown: string): string {
  const collapse = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    // Whitespace between two block elements is indentation of the markup, not of the paragraph it precedes.
    .replace(/(\n[ \t]*\n)[ \t]+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
  return markdown.split(/(```[\s\S]*?```)/g).map((part, index) => (index % 2 === 1 ? part : collapse(part))).join('').trim()
}
/** jsonML stored as a JSON string, which the API also returns for a description written by the rich-text editor. */
function storedJsonml(text: string): unknown[] | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : undefined
  } catch { return undefined /* A description that only looks like JSON is plain text. */ }
}

/**
 * Converts a yunxiao rich-text value into Markdown.
 * `p/br/strong/em/code/pre/ul/ol/li/a/h1-h3/blockquote/img` become their Markdown forms, any other tag keeps its text,
 * and character references are decoded. `null` and `undefined` convert to an empty string.
 */
export function richText(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') {
    const jsonml = storedJsonml(input)
    if (jsonml) return tidy(renderNodes(jsonmlTree(jsonml), 0))
    return tidy(HTML_TAG.test(input) ? renderNodes(htmlTree(input), 0) : decodeEntities(input))
  }
  if (Array.isArray(input)) return tidy(renderNodes(jsonmlTree(input), 0))
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>
    // Editors wrap the body in an object whose key differs by field (`description`, `content`, `html`).
    const nested = record.html ?? record.text ?? record.content ?? record.jsonml ?? record.value
    return nested === undefined ? '' : richText(nested)
  }
  return tidy(String(input))
}
