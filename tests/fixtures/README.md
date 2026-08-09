# Face-detection fixtures

Three JPEGs used by the faces integration suite (Task 2) and the Dockerfile's build-time face
probe (`scripts/probe-faces.mjs`). All three are official NASA/JAXA astronaut portraits: works of
the U.S. federal government are public domain under 17 U.S.C. §105, and Wikimedia Commons tags
them `PD-USGov-NASA`. None depicts a Verein member or any other private individual — this
repository is public.

Each file was downloaded from Wikimedia Commons, cropped to head-and-shoulders where the source
was a full-length shot, and re-encoded with `sharp` at ≤1600px on the long edge to keep the repo
small. Re-encoding strips EXIF/metadata; provenance is recorded here instead.

## gesicht-a.jpg / gesicht-b.jpg — same person, two different photographs

Subject: **Akihiko Hoshide** (JAXA astronaut). Used by the "same person, two photos" match
assertion — the whole point of ArcFace alignment is that these should embed close together
despite being different sessions, angles and years.

- `gesicht-a.jpg` — cropped from *"Akihiko Hoshide, official portrait (2020)"*
  <https://commons.wikimedia.org/wiki/File:Akihiko_Hoshide,_official_portrait_(2020).jpg>
  Credit: NASA / Robert Markowitz. License: Public domain (`PD-USGov-NASA`, via
  `Files from NASA Johnson Flickr stream`). Original full-length studio portrait, taken
  2020-09-22; cropped here to head-and-shoulders so the face occupies a comparable fraction of
  the frame to `gesicht-b.jpg`.
- `gesicht-b.jpg` — *"Akihiko Hoshide"* (2004 ASCAN class official portrait)
  <https://commons.wikimedia.org/wiki/File:Akihiko_Hoshide.jpg>
  Credit: NASA Johnson Space Center. License: Public domain (`PD-USGov-NASA`). Taken
  2004-08-17 — a different photograph, 16 years apart from `gesicht-a.jpg`.

## gesicht-c.jpg — a different person

Subject: **Kent Rominger** (NASA astronaut). Used as the "different person" negative case —
should NOT match `gesicht-a.jpg` / `gesicht-b.jpg` above threshold, and is also the fixture
copied into the Dockerfile's face-probe stage.

- `gesicht-c.jpg` — *"NASA Astronaut Kent Rominger"*
  <https://commons.wikimedia.org/wiki/File:NASA_Astronaut_Kent_Rominger.jpg>
  Credit: NASA. License: Public domain (`PD-USGov-NASA`).

All three are front-facing, unobstructed (no EMU helmet/visor), studio-lit portraits — the
easiest case for both the SCRFD detector and ArcFace alignment, which is what the acceptance
tests need: a clean signal on whether the pipeline works at all, not a stress test of the model's
accuracy under harder conditions.
