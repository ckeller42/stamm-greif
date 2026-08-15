import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from '@react-pdf/renderer'

// A ready-to-render image buffer, or null (missing file → cell/cover omitted).
export type FotobuchImage = { data: Buffer; format: 'jpg' } | null

// The PDF's per-photo VIEW MODEL — deliberately a different (narrower, pre-formatted) shape from
// src/lib/fotobuch-query.ts's `FotobuchPhoto` (the raw consent-filtered query result). Same name,
// different module, different purpose: this one carries a ready-to-embed image buffer + already-
// formatted caption/date strings, not Payload field data. Callers that need both types (Task 5)
// import them under distinct aliases.
export type FotobuchPhoto = { image: FotobuchImage; caption: string | null; dateLabel: string }

// A FotobuchPhoto proven (by renderablePhotos()'s type-guard filter below) to carry a real image.
type RenderablePhoto = FotobuchPhoto & { image: NonNullable<FotobuchImage> }

export type FotobuchHistory = {
  gruppenHeading: string
  memberships: string[] // preformatted "Sippe Rotmilan · Sippenführer · 1985–1989"
  ereignisseHeading: string
  events: string[]
}

// A photo whose image transcode failed (missing/undecodable file — photoToJpegBuffer()'s soft
// skip) has nothing left to show: no caption/date pair is meaningful without the picture it
// belongs to. Filtering these out — rather than rendering an empty cell — is what makes a missing
// file silently drop from the book instead of leaving a visible gap, and what makes an
// all-missing photo set correctly hit the "no photos" empty state instead of a grid of blanks
// (CodeRabbit review, PR #23). Exported so this can be unit-tested directly, independent of
// parsing the rendered PDF's content.
export function renderablePhotos(photos: FotobuchPhoto[]): RenderablePhoto[] {
  return photos.filter((p): p is RenderablePhoto => p.image !== null)
}

export type FotobuchBook = {
  title: string
  subtitle: string
  cover: FotobuchImage
  storyHeading: string
  story: string // plain text (event story / series description / person bio); '' → section omitted
  history: FotobuchHistory | null // person book only
  photos: FotobuchPhoto[]
  photosHeading: string
  emptyPhotosLabel: string
  truncatedNote: string | null
  footer: string
}

const styles = StyleSheet.create({
  cover: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 48 },
  coverImage: { width: '100%', height: 320, objectFit: 'cover', marginBottom: 24 },
  title: { fontSize: 30, textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#555', textAlign: 'center' },
  footer: { position: 'absolute', bottom: 24, left: 48, right: 48, textAlign: 'center', fontSize: 9, color: '#999' },
  page: { paddingVertical: 40, paddingHorizontal: 48 },
  heading: { fontSize: 18, marginBottom: 10, marginTop: 6 },
  story: { fontSize: 11, lineHeight: 1.5, marginBottom: 6 },
  listItem: { fontSize: 11, lineHeight: 1.5, marginBottom: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '50%', padding: 6 },
  cellImage: { width: '100%', height: 200, objectFit: 'contain', backgroundColor: '#f2f2f2' },
  caption: { fontSize: 9, marginTop: 3 },
  date: { fontSize: 8, color: '#777' },
  note: { fontSize: 9, color: '#999', marginTop: 8 },
})

// Assembles a Fotobuch PDF from an already consent-filtered, already-formatted FotobuchBook — no
// data fetching, no access control here (spec: that safety boundary lives entirely in Task 2/
// Task 5). Renders exactly what it is given: cover, story/bio + optional person history, then a
// chronological captioned photo grid. A4, German copy supplied by the caller, built-in Helvetica
// (WinAnsi covers German umlauts + en-dash — Task 1's probe confirmed this, no embedded font).
export async function renderFotobuchPdf(book: FotobuchBook): Promise<Buffer> {
  // Missing/undecodable-file entries never reach the grid — see renderablePhotos()'s doc above.
  const photos = renderablePhotos(book.photos)
  const doc = (
    <Document title={book.title}>
      {/* Cover */}
      <Page size="A4">
        <View style={styles.cover}>
          {book.cover && <Image style={styles.coverImage} src={book.cover} />}
          <Text style={styles.title}>{book.title}</Text>
          {book.subtitle ? <Text style={styles.subtitle}>{book.subtitle}</Text> : null}
          {book.truncatedNote ? <Text style={styles.note}>{book.truncatedNote}</Text> : null}
        </View>
        {/* `fixed` repeats this on every page react-pdf paginates to (spec: the photo grid page
            can wrap across many pages) — without it, only the FIRST page of a wrapped section
            would carry the footer (CodeRabbit review, PR #23). */}
        <Text style={styles.footer} fixed>{book.footer}</Text>
      </Page>

      {/* Story / bio + person history */}
      {(book.story || book.history) && (
        <Page size="A4" style={styles.page}>
          {book.story ? (
            <View>
              <Text style={styles.heading}>{book.storyHeading}</Text>
              {book.story.split('\n\n').map((para, i) => (
                <Text key={`p${i}`} style={styles.story}>{para}</Text>
              ))}
            </View>
          ) : null}
          {book.history ? (
            <View>
              <Text style={styles.heading}>{book.history.gruppenHeading}</Text>
              {book.history.memberships.map((m, i) => (
                <Text key={`m${i}`} style={styles.listItem}>{m}</Text>
              ))}
              <Text style={styles.heading}>{book.history.ereignisseHeading}</Text>
              {book.history.events.map((e, i) => (
                <Text key={`e${i}`} style={styles.listItem}>{e}</Text>
              ))}
            </View>
          ) : null}
          <Text style={styles.footer} fixed>{book.footer}</Text>
        </Page>
      )}

      {/* Photo grid — react-pdf paginates automatically via wrap */}
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.heading}>{book.photosHeading}</Text>
        {photos.length === 0 ? (
          <Text style={styles.story}>{book.emptyPhotosLabel}</Text>
        ) : (
          <View style={styles.grid}>
            {photos.map((p, i) => (
              <View key={`ph${i}`} style={styles.cell} wrap={false}>
                <Image style={styles.cellImage} src={p.image} />
                {p.caption ? <Text style={styles.caption}>{p.caption}</Text> : null}
                <Text style={styles.date}>{p.dateLabel}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={styles.footer} fixed>{book.footer}</Text>
      </Page>
    </Document>
  )
  return renderToBuffer(doc)
}
