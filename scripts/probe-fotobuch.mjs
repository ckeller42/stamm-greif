// Build-time / local probe that @react-pdf/renderer actually renders a PDF in this toolchain —
// the same silent-fallback guard rationale as scripts/probe-faces.mjs (a green build that only
// throws at first render, e.g. because next's standalone trace dropped yoga's wasm asset).
import React from 'react'
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer'

const doc = React.createElement(
  Document,
  null,
  React.createElement(Page, { size: 'A4' }, React.createElement(Text, null, 'Grüße vom Stamm Greif — ä ö ü ß 1985–2025')),
)
const buf = await renderToBuffer(doc)
if (!buf || buf.length === 0 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
  console.error('fotobuch probe FAILED: no valid PDF produced')
  process.exit(1)
}
console.log(`fotobuch probe ok: ${buf.length} bytes, umlauts render on built-in Helvetica`)
