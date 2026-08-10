import { QrCode, QrSegment } from './vendor/qr-codegen'

// P2.4 — server-side QR → self-contained inline SVG for the kiosk slideshow. No npm dependency
// (vendored pure-TS encoder), no client-side QR code, no external asset — safe to inline under the
// app's CSP. Medium error correction tolerates a little beamer glare/skew on a phone camera.
export function qrSvg(text: string, opts: { margin?: number } = {}): string {
  const margin = opts.margin ?? 2
  const qr = QrCode.encodeSegments(QrSegment.makeSegments(text), QrCode.Ecc.MEDIUM)
  const size = qr.size + margin * 2
  let path = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) path += `M${x + margin},${y + margin}h1v1h-1z`
    }
  }
  // viewBox in module units, white background + black modules (fixed colours — the slideshow
  // renders this over arbitrary photo backgrounds, so it needs its own quiet zone/contrast rather
  // than inheriting page colour). crispEdges keeps the modules sharp at any scale on the beamer.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR-Code zum Herunterladen">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`
  )
}
