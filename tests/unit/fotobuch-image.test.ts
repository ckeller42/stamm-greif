import { describe, it, expect, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises'
import { photoToJpegBuffer } from '@/lib/fotobuch-image'

// photoToJpegBuffer resolves files under `<process.cwd()>/photos` (the established
// detectFaces.ts/kiosk-image pattern) — spying on process.cwd() lets these tests point that
// resolution at a throwaway temp directory instead of the real (gitignored, live-stack) /photos.
const fixture = path.resolve(process.cwd(), 'tests/fixtures/dia.jpg')

async function withTempPhotosDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fotobuch-image-'))
  const photosDir = path.join(root, 'photos')
  await mkdir(photosDir)
  const spy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  try {
    await fn(photosDir)
  } finally {
    spy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}

describe('photoToJpegBuffer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('transcodes a real on-disk image (web derivative) to a bounded JPEG buffer', async () => {
    await withTempPhotosDir(async (photosDir) => {
      await copyFile(fixture, path.join(photosDir, 'web-derivative.jpg'))
      const buf = await photoToJpegBuffer({
        id: 1,
        filename: 'original.jpg',
        sizes: { web: { filename: 'web-derivative.jpg' } },
      })
      expect(buf).not.toBeNull()
      expect(buf!.length).toBeGreaterThan(0)
      // JPEG magic bytes (FF D8 FF) — proves sharp actually transcoded to JPEG, not a passthrough.
      expect(buf!.subarray(0, 3).toString('hex')).toBe('ffd8ff')
    })
  })

  it('falls back to the original filename when no web derivative exists', async () => {
    await withTempPhotosDir(async (photosDir) => {
      await copyFile(fixture, path.join(photosDir, 'original-only.jpg'))
      const buf = await photoToJpegBuffer({ id: 2, filename: 'original-only.jpg', sizes: null })
      expect(buf).not.toBeNull()
      expect(buf!.subarray(0, 3).toString('hex')).toBe('ffd8ff')
    })
  })

  it('returns null (soft skip) and logs when the file is missing on disk — never crashes the book', async () => {
    await withTempPhotosDir(async () => {
      const info = vi.fn()
      const buf = await photoToJpegBuffer(
        { id: 42, filename: 'does-not-exist.jpg', sizes: null },
        { info } as unknown as Parameters<typeof photoToJpegBuffer>[1],
      )
      expect(buf).toBeNull()
      expect(info).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ msg: 'fotobuch-image-skipped', photoId: 42 }))
    })
  })

  it('returns null when neither filename nor sizes.web.filename is present', async () => {
    await withTempPhotosDir(async () => {
      const buf = await photoToJpegBuffer({ id: 7 })
      expect(buf).toBeNull()
    })
  })

  it('returns null (soft skip) when the file exists but is not a decodable image', async () => {
    await withTempPhotosDir(async (photosDir) => {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path.join(photosDir, 'garbage.jpg'), 'not actually an image')
      const info = vi.fn()
      const buf = await photoToJpegBuffer(
        { id: 9, filename: 'garbage.jpg' },
        { info } as unknown as Parameters<typeof photoToJpegBuffer>[1],
      )
      expect(buf).toBeNull()
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ msg: 'fotobuch-image-skipped', photoId: 9 }))
    })
  })
})
