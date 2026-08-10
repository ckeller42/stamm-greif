'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

type Slide = {
  id: number
  src: string
  caption: string
  qr: string
}

// P2.4 — the beamer-facing client half of /kiosk. Everything here is presentation only: the
// consent-safe slide list (already filtered + QR-signed) comes in as props from the server
// component, this component never fetches anything itself.
export function Slideshow({
  slides,
  intervalMs,
  scanHint,
}: {
  slides: Slide[]
  intervalMs: number
  scanHint: string
}) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const count = slides.length
  const next = useCallback(() => setIndex((i) => (i + 1) % count), [count])
  const prev = useCallback(() => setIndex((i) => (i - 1 + count) % count), [count])
  const togglePause = useCallback(() => setPaused((p) => !p), [])

  // Auto-advance, skipped while paused. Re-armed on every index/paused change rather than one
  // long-lived interval so a manual step (tap/arrow key) resets the dwell time instead of the
  // next auto-advance landing early.
  useEffect(() => {
    if (paused || count <= 1) return
    const id = setInterval(next, intervalMs)
    return () => clearInterval(id)
  }, [paused, next, intervalMs, count])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === ' ') {
        e.preventDefault()
        togglePause()
      } else if (e.key === 'f' || e.key === 'F') {
        rootRef.current?.requestFullscreen?.().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [next, prev, togglePause])

  if (count === 0) return null
  const slide = slides[index]

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000', overflow: 'hidden' }}>
      <img
        key={slide.id}
        src={slide.src}
        alt=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />

      {slide.caption && (
        <div
          style={{
            position: 'absolute',
            left: '1.5rem',
            bottom: '1.5rem',
            maxWidth: '60vw',
            padding: '0.5rem 0.75rem',
            background: 'rgba(0,0,0,0.55)',
            color: '#eee',
            fontSize: '1.25rem',
            borderRadius: 4,
          }}
        >
          {slide.caption}
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          right: '1.5rem',
          bottom: '1.5rem',
          width: 140,
          textAlign: 'center',
          color: '#eee',
        }}
      >
        <div style={{ width: 140, height: 140 }} dangerouslySetInnerHTML={{ __html: slide.qr }} />
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem' }}>{scanHint}</p>
      </div>

      {/* Tap zones: left third = prev, right third = next, middle third = pause/resume. Sit above
          the image/caption/QR (z-index) but carry no visible chrome — the beamer output must stay
          clean; controls are for whoever is standing at the kiosk with a finger or a keyboard. */}
      <button
        type="button"
        aria-label="Zurück"
        onClick={prev}
        style={{ position: 'absolute', inset: '0 66.6% 0 0', width: '33.3%', background: 'transparent', border: 0, cursor: 'pointer' }}
      />
      <button
        type="button"
        aria-label={paused ? 'Fortsetzen' : 'Pausieren'}
        onClick={togglePause}
        style={{ position: 'absolute', inset: '0 33.3%', width: '33.4%', background: 'transparent', border: 0, cursor: 'pointer' }}
      />
      <button
        type="button"
        aria-label="Weiter"
        onClick={next}
        style={{ position: 'absolute', inset: '0 0 0 66.6%', width: '33.3%', background: 'transparent', border: 0, cursor: 'pointer' }}
      />
    </div>
  )
}
