import { describe, it, expect } from 'vitest'
import { lexicalToPlainText } from '@/lib/lexical-text'

const state = (children: unknown[]) => ({ root: { type: 'root', children } })
const para = (text: string) => ({ type: 'paragraph', children: [{ type: 'text', text }] })

describe('lexicalToPlainText', () => {
  it('joins paragraphs with blank lines', () => {
    expect(lexicalToPlainText(state([para('Erster Absatz.'), para('Zweiter Absatz.')]))).toBe(
      'Erster Absatz.\n\nZweiter Absatz.',
    )
  })

  it('keeps link text, drops the url', () => {
    const withLink = state([
      { type: 'paragraph', children: [
        { type: 'text', text: 'siehe ' },
        { type: 'link', fields: { url: 'https://x' }, children: [{ type: 'text', text: 'hier' }] },
      ] },
    ])
    expect(lexicalToPlainText(withLink)).toBe('siehe hier')
  })

  it('turns a linebreak node into a newline', () => {
    const br = state([{ type: 'paragraph', children: [
      { type: 'text', text: 'Zeile 1' }, { type: 'linebreak' }, { type: 'text', text: 'Zeile 2' },
    ] }])
    expect(lexicalToPlainText(br)).toBe('Zeile 1\nZeile 2')
  })

  it('returns empty string for missing/empty/garbage input', () => {
    expect(lexicalToPlainText(null)).toBe('')
    expect(lexicalToPlainText(undefined)).toBe('')
    expect(lexicalToPlainText({})).toBe('')
    expect(lexicalToPlainText({ root: {} })).toBe('')
    expect(lexicalToPlainText(state([]))).toBe('')
  })

  it('drops blank/whitespace-only paragraphs', () => {
    const withBlank = state([para('Erster.'), { type: 'paragraph', children: [{ type: 'text', text: '   ' }] }, para('Zweiter.')])
    expect(lexicalToPlainText(withBlank)).toBe('Erster.\n\nZweiter.')
  })

  it('handles nested children (e.g. bold text inside a paragraph)', () => {
    const nested = state([
      { type: 'paragraph', children: [
        { type: 'text', text: 'normal ' },
        { type: 'bold', children: [{ type: 'text', text: 'fett' }] },
        { type: 'text', text: ' weiter' },
      ] },
    ])
    expect(lexicalToPlainText(nested)).toBe('normal fett weiter')
  })

  it('handles deeply nested children', () => {
    const deep = state([
      { type: 'paragraph', children: [
        { type: 'a', children: [
          { type: 'b', children: [
            { type: 'c', children: [{ type: 'text', text: 'ganz unten' }] },
          ] },
        ] },
      ] },
    ])
    expect(lexicalToPlainText(deep)).toBe('ganz unten')
  })

  it('ignores non-text nodes with no children (e.g. images, horizontal rules)', () => {
    const withMedia = state([
      para('Vorher.'),
      { type: 'upload', fields: { url: 'https://x/img.jpg' } },
      { type: 'horizontalrule' },
      para('Nachher.'),
    ])
    expect(lexicalToPlainText(withMedia)).toBe('Vorher.\n\nNachher.')
  })

  it('never throws on malformed nodes and skips them', () => {
    const malformed = state([null, undefined, 'not-an-object', 42, true, para('gültig.')])
    expect(() => lexicalToPlainText(malformed)).not.toThrow()
    expect(lexicalToPlainText(malformed)).toBe('gültig.')
  })

  it('never throws on malformed children arrays inside a node', () => {
    const malformedChildren = state([
      { type: 'paragraph', children: [null, { type: 'text', text: 'ok' }, 123, undefined] },
    ])
    expect(() => lexicalToPlainText(malformedChildren)).not.toThrow()
    expect(lexicalToPlainText(malformedChildren)).toBe('ok')
  })

  it('returns empty string when root.children is not an array', () => {
    expect(lexicalToPlainText({ root: { type: 'root', children: 'not-an-array' } })).toBe('')
    expect(lexicalToPlainText({ root: { type: 'root', children: null } })).toBe('')
  })

  it('returns empty string for a totally malformed state (never throws)', () => {
    expect(() => lexicalToPlainText('just a string')).not.toThrow()
    expect(lexicalToPlainText('just a string' as unknown)).toBe('')
    expect(() => lexicalToPlainText(42)).not.toThrow()
    expect(lexicalToPlainText(42 as unknown)).toBe('')
    expect(() => lexicalToPlainText([])).not.toThrow()
    expect(lexicalToPlainText([] as unknown)).toBe('')
  })
})
