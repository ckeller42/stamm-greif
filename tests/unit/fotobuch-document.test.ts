import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { renderFotobuchPdf, type FotobuchBook, type FotobuchImage } from '@/lib/fotobuch-document'

const fixture = path.resolve(process.cwd(), 'tests/fixtures/dia.jpg')

function expectValidPdf(buf: Buffer): void {
  expect(buf).toBeInstanceOf(Buffer)
  expect(buf.length).toBeGreaterThan(0)
  // %PDF- magic bytes — same check as scripts/probe-fotobuch.mjs; no pdf-parse dep needed.
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
}

function baseBook(overrides: Partial<FotobuchBook> = {}): FotobuchBook {
  return {
    title: 'Sommerlager 1989',
    subtitle: '12.08.1989',
    cover: null,
    storyHeading: 'Geschichte',
    story: '',
    history: null,
    photos: [],
    photosHeading: 'Fotos',
    emptyPhotosLabel: 'Keine Fotos vorhanden.',
    truncatedNote: null,
    footer: 'Stamm Greif — Archiv',
    ...overrides,
  }
}

describe('renderFotobuchPdf', () => {
  it('renders a minimal book (no cover, no story, no history, no photos) to a valid PDF buffer', async () => {
    const buf = await renderFotobuchPdf(baseBook())
    expectValidPdf(buf)
  })

  it('renders an event book: cover image, umlaut/en-dash story, chronological captioned photo grid', async () => {
    const image: FotobuchImage = { data: await readFile(fixture), format: 'jpg' }
    const book = baseBook({
      cover: image,
      subtitle: '1985–1989',
      story: 'Ein schönes Lager in Grünwald.\n\nWir waren überglücklich — bis zum Regen.',
      truncatedNote: 'Aus 320 Fotos wurden 300 ausgewählt.',
      photos: [
        { image, caption: 'Lagerfeuer', dateLabel: '12.08.1989' },
        { image: null, caption: null, dateLabel: '1989er Jahre' }, // missing file → cell omits <Image>
      ],
    })
    const buf = await renderFotobuchPdf(book)
    expectValidPdf(buf)
  })

  it('renders without a subtitle and with history-but-no-story (both falsy branches)', async () => {
    const book = baseBook({
      subtitle: '',
      story: '',
      history: {
        gruppenHeading: 'Gruppen',
        memberships: [],
        ereignisseHeading: 'Ereignisse',
        events: [],
      },
    })
    const buf = await renderFotobuchPdf(book)
    expectValidPdf(buf)
  })

  it('renders a person book: bio + group/event history section, empty photos label', async () => {
    const book = baseBook({
      title: 'Jürgen Müller',
      subtitle: '* 1974',
      storyHeading: 'Über',
      story: 'Seit 1985 dabei.',
      history: {
        gruppenHeading: 'Gruppen',
        memberships: ['Sippe Rotmilan · Sippenführer · 1985–1989'],
        ereignisseHeading: 'Ereignisse',
        events: ['Sommerlager 1989'],
      },
      photos: [],
    })
    const buf = await renderFotobuchPdf(book)
    expectValidPdf(buf)
  })

  it('paginates a large photo set without throwing (wrap works across many cells)', async () => {
    const image: FotobuchImage = { data: await readFile(fixture), format: 'jpg' }
    const photos = Array.from({ length: 40 }, (_, i) => ({
      image,
      caption: `Foto ${i + 1}`,
      dateLabel: '1989',
    }))
    const buf = await renderFotobuchPdf(baseBook({ photos }))
    expectValidPdf(buf)
  })
})
