// Integration test: Local API only — no HTTP endpoint exists yet (that's Task 5), so this needs
// only the TEST database (see package.json's test:int script for the db-test:5433 wiring), not
// the running dev server.
//
// This is the fotobuch consent safety property (spec §3): a photo enters a book's photo set ONLY
// if published AND not-hidden-person AND not-binned — collectFotobuchPhotos() re-applies this via
// fotobuchPhotoWhere() with overrideAccess:true, EVEN THOUGH nothing here authenticates as a
// kurator (whose canReadPhoto would otherwise say yes to everything). The single most important
// case: a hidden-person photo must be absent from the built set even when its id is NOT passed in
// excludeIds — excludeIds is subtract-only and must never be what keeps a hidden photo out.
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import {
  collectFotobuchPhotos,
  FOTOBUCH_MAX_PHOTOS,
  FotobuchHiddenPersonError,
} from '@/lib/fotobuch-query'

let payload: Payload
const fixture = path.resolve(process.cwd(), 'tests/fixtures/dia.jpg')
const stamp = Date.now()
let fixtureBytes: Buffer
let photoNameCounter = 0

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  fixtureBytes = await fs.readFile(fixture)
})

async function makeEvent(name: string, seriesId?: number): Promise<number> {
  const doc = await payload.create({
    collection: 'events',
    data: { name, series: seriesId } as any,
    overrideAccess: true,
  })
  return Number(doc.id)
}

async function makeSeries(name: string): Promise<number> {
  const doc = await payload.create({ collection: 'event-series', data: { name }, overrideAccess: true })
  return Number(doc.id)
}

async function makePerson(name: string, hidden = false): Promise<number> {
  const doc = await payload.create({
    collection: 'people',
    data: { name, hidden },
    overrideAccess: true,
  })
  return Number(doc.id)
}

async function makePhoto(over: Record<string, unknown>): Promise<number> {
  // A distinct filename per call (rather than a shared filePath) avoids a real Payload upload
  // race: two concurrent creates of the same source filename can both see it "available" before
  // either insert lands, then collide on the unique filename constraint. Only matters for the
  // cap test below, which creates many photos concurrently — harmless for the sequential tests.
  const name = `dia-${stamp}-${photoNameCounter++}.jpg`
  const doc = await payload.create({
    collection: 'photos',
    data: { datePrecision: 'year', dateValue: '1990', ...over } as any,
    file: { data: fixtureBytes, mimetype: 'image/jpeg', name, size: fixtureBytes.length },
    overrideAccess: true,
  })
  return Number(doc.id)
}

function ids(photos: { id: number }[]): number[] {
  return photos.map((p) => p.id)
}

describe('collectFotobuchPhotos — event subject', () => {
  it('returns only published, not-hidden-person, not-binned photos of the event', async () => {
    const eventId = await makeEvent(`Fest ${stamp}-A`)
    const otherEventId = await makeEvent(`Anderes Fest ${stamp}-A`)

    const eligible = await makePhoto({ _status: 'published', event: eventId })
    const draft = await makePhoto({ _status: 'draft', event: eventId })
    const binned = await makePhoto({
      _status: 'published',
      event: eventId,
      deletedAt: new Date().toISOString(),
    })
    const otherEvent = await makePhoto({ _status: 'published', event: otherEventId })

    const result = await collectFotobuchPhotos(payload, { type: 'event', id: eventId })
    const resultIds = ids(result)

    expect(resultIds).toContain(eligible)
    expect(resultIds).not.toContain(draft)
    expect(resultIds).not.toContain(binned)
    expect(resultIds).not.toContain(otherEvent)
  })

  it('a hidden-person photo is ABSENT from the event book even when its id is NOT in excludeIds', async () => {
    const eventId = await makeEvent(`Fest ${stamp}-B`)
    const hiddenPerson = await makePerson(`Verborgen ${stamp}-B`, true)

    const eligible = await makePhoto({ _status: 'published', event: eventId })
    const hiddenPersonPhoto = await makePhoto({
      _status: 'published',
      event: eventId,
      people: [hiddenPerson],
    })

    // No excludeIds passed at all — the hidden-person photo must still never appear.
    const result = await collectFotobuchPhotos(payload, { type: 'event', id: eventId })
    const resultIds = ids(result)

    expect(resultIds).toContain(eligible)
    expect(resultIds).not.toContain(hiddenPersonPhoto)
  })
})

describe('collectFotobuchPhotos — series subject', () => {
  it('resolves the series to its events, then collects eligible photos across them', async () => {
    const seriesId = await makeSeries(`Reihe ${stamp}-C`)
    const eventA = await makeEvent(`Fest ${stamp}-C-A`, seriesId)
    const eventB = await makeEvent(`Fest ${stamp}-C-B`, seriesId)
    const unrelatedEvent = await makeEvent(`Fest ${stamp}-C-Unrelated`)

    const inA = await makePhoto({ _status: 'published', event: eventA })
    const inB = await makePhoto({ _status: 'published', event: eventB })
    const draftInA = await makePhoto({ _status: 'draft', event: eventA })
    const outside = await makePhoto({ _status: 'published', event: unrelatedEvent })

    const result = await collectFotobuchPhotos(payload, { type: 'series', id: seriesId })
    const resultIds = ids(result)

    expect(resultIds).toContain(inA)
    expect(resultIds).toContain(inB)
    expect(resultIds).not.toContain(draftInA)
    expect(resultIds).not.toContain(outside)
  })

  it('a series with no events returns an empty set', async () => {
    const seriesId = await makeSeries(`Leere Reihe ${stamp}-C2`)
    const result = await collectFotobuchPhotos(payload, { type: 'series', id: seriesId })
    expect(result).toEqual([])
  })
})

describe('collectFotobuchPhotos — person subject', () => {
  it('returns only that (visible) person’s eligible photos', async () => {
    const personA = await makePerson(`Person ${stamp}-D-A`)
    const personB = await makePerson(`Person ${stamp}-D-B`)

    const ofA = await makePhoto({ _status: 'published', people: [personA] })
    const ofB = await makePhoto({ _status: 'published', people: [personB] })
    const draftOfA = await makePhoto({ _status: 'draft', people: [personA] })

    const result = await collectFotobuchPhotos(payload, { type: 'person', id: personA })
    const resultIds = ids(result)

    expect(resultIds).toContain(ofA)
    expect(resultIds).not.toContain(ofB)
    expect(resultIds).not.toContain(draftOfA)
  })

  it('refuses a person-book for a hidden person (FotobuchHiddenPersonError)', async () => {
    const hiddenPerson = await makePerson(`Verborgen ${stamp}-D-C`, true)
    await makePhoto({ _status: 'published', people: [hiddenPerson] })

    await expect(
      collectFotobuchPhotos(payload, { type: 'person', id: hiddenPerson }),
    ).rejects.toBeInstanceOf(FotobuchHiddenPersonError)
  })

  it('photos of a hidden person never appear in a co-tagged VISIBLE person’s book either', async () => {
    const visible = await makePerson(`Sichtbar ${stamp}-D-D`)
    const hidden = await makePerson(`Verborgen ${stamp}-D-D`, true)
    const coTagged = await makePhoto({ _status: 'published', people: [visible, hidden] })
    const soloVisible = await makePhoto({ _status: 'published', people: [visible] })

    const result = await collectFotobuchPhotos(payload, { type: 'person', id: visible })
    const resultIds = ids(result)

    expect(resultIds).toContain(soloVisible)
    expect(resultIds).not.toContain(coTagged) // hasHiddenPerson is recomputed across all its people
  })
})

describe('collectFotobuchPhotos — excludeIds is subtract-only', () => {
  it('removes an otherwise-eligible photo when its id is passed', async () => {
    const eventId = await makeEvent(`Fest ${stamp}-E`)
    const keep = await makePhoto({ _status: 'published', event: eventId })
    const drop = await makePhoto({ _status: 'published', event: eventId })

    const result = await collectFotobuchPhotos(payload, {
      type: 'event',
      id: eventId,
      excludeIds: [drop],
    })
    const resultIds = ids(result)

    expect(resultIds).toContain(keep)
    expect(resultIds).not.toContain(drop)
  })

  it('cannot re-admit a hidden-person photo by simply omitting it from excludeIds, nor widen the set via excludeIds at all', async () => {
    const eventId = await makeEvent(`Fest ${stamp}-F`)
    const hiddenPerson = await makePerson(`Verborgen ${stamp}-F`, true)
    const eligible = await makePhoto({ _status: 'published', event: eventId })
    const hiddenPersonPhoto = await makePhoto({
      _status: 'published',
      event: eventId,
      people: [hiddenPerson],
    })

    // Passing an unrelated/nonexistent id in excludeIds must not affect anything, and must not
    // somehow re-admit the hidden photo.
    const result = await collectFotobuchPhotos(payload, {
      type: 'event',
      id: eventId,
      excludeIds: [999999999],
    })
    const resultIds = ids(result)

    expect(resultIds).toContain(eligible)
    expect(resultIds).not.toContain(hiddenPersonPhoto)
  })
})

describe('collectFotobuchPhotos — FOTOBUCH_MAX_PHOTOS cap', () => {
  it('caps the returned set at FOTOBUCH_MAX_PHOTOS even when more are eligible', async () => {
    const eventId = await makeEvent(`Grosses Fest ${stamp}-G`)
    const count = FOTOBUCH_MAX_PHOTOS + 5
    const batchSize = 20
    for (let start = 0; start < count; start += batchSize) {
      const batch = Math.min(batchSize, count - start)
      await Promise.all(
        Array.from({ length: batch }, () => makePhoto({ _status: 'published', event: eventId })),
      )
    }

    const result = await collectFotobuchPhotos(payload, { type: 'event', id: eventId })
    expect(result.length).toBe(FOTOBUCH_MAX_PHOTOS)
  }, 180_000)
})
