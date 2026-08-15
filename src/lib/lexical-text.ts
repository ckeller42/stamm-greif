// Lexical (SerializedEditorState) → plain text for the PDF. v1 fidelity is deliberately narrow
// (spec §6.4): paragraphs and line breaks only — no bold/italic, no list markers, link TEXT kept
// but its url dropped. Enough for a printed story; richer typography is a later-phase item. Pure,
// so it lives in src/lib and is covered by test:unit's src/lib/** include.
type LexNode = { type?: string; text?: string; children?: unknown; [k: string]: unknown }

// Real Payload data can't nest this deep or cycle (richText is stored as JSON, which can't encode
// cycles), but the contract is never-throw — a depth cap stops a pathological or malformed tree
// from blowing the call stack (RangeError) instead of returning text.
const MAX_DEPTH = 500

function nodeText(node: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return ''
  if (typeof node !== 'object' || node === null) return ''
  const n = node as LexNode
  if (n.type === 'linebreak') return '\n'
  if (typeof n.text === 'string') return n.text
  if (Array.isArray(n.children)) return (n.children as unknown[]).map((c) => nodeText(c, depth + 1)).join('')
  return ''
}

export function lexicalToPlainText(state: unknown): string {
  const root = (state as { root?: LexNode } | null | undefined)?.root
  if (!root || !Array.isArray(root.children)) return ''
  const blocks: string[] = []
  for (const child of root.children as unknown[]) {
    const text = nodeText(child).trim()
    if (text) blocks.push(text)
  }
  return blocks.join('\n\n')
}
