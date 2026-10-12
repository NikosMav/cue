# Presentation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `presentation` setup kind that helps the presenter of an online educational talk with per-slide talking points, pacing and coverage, audience Q&A, and a debrief.

**Architecture:** A third setup kind alongside `interview` and `general`. A deck (PPTX/PDF) is imported into a per-setup JSON file and enriched once with the Smart model. During the talk, the existing slide hash poll in `main.js` feeds a matcher (hash cache, then one fast vision call) that drives a pure presentation-state module; Q&A reuses `AutoAnswer` with a new prompt layer. New logic lives in small pure modules with injected I/O; `main.js` and `renderer.js` only wire them up.

**Tech Stack:** Electron 44, Node `node:test` (`npm test` = `node --test test/*.test.js`), `jszip` 3.10.x (new direct dependency), `pdf-parse` (existing).

**Spec:** `docs/superpowers/specs/2026-10-13-presentation-mode-design.md`

## Global Constraints

- Work on `main`; commit after each task; never push unless asked.
- No UI animations or transitions anywhere (content swaps instantly).
- Only new dependency: `jszip` at the version already installed via mammoth (`^3.10.1`).
- Interview and general prompt outputs stay byte-identical; every existing test in `test/` keeps passing.
- No screenshots written to disk. `matchCache` stores only 16-hex-char hashes and numbers.
- File dialogs run in main; the renderer never supplies a file path.
- About me is not changed by anything in this feature.
- Limits: 50 MB deck file; 150 visible slides; body 2,000 chars, notes 3,000 chars per slide, cut with `\n[…truncated]`; point 140, question 160, keyIdea 120 chars; enrichment batch size 8; at most 6 `questions` per slide after debrief feedback.
- Live thresholds: poll 1,000 ms, stable count 2, Hamming threshold 5, flicked-past < 8 s, coverage check after ≥ 20 s dwell, on track = margin within ±15% of planned duration, coverage transcript cap 4,000 chars, Q&A transcript cap 6,000 chars.
- `durationMin` default 45, clamped 5..240.
- Shortcuts: `slidePrev` = `CommandOrControl+Alt+Left`, `slideNext` = `CommandOrControl+Alt+Right`.

## Review Focus

1. **Talk runs past its planned length** — remaining time goes negative; the strip must show `0:00 left · ▼ behind N min`, never NaN or a negative clock. Test in Task 8.
2. **Deck re-imported or setup switched while listening** — the live loop must reload the deck and reset state; a cached or current slide number beyond the new `slideCount` must be treated as unknown, not crash. Tests in Tasks 8 and 9.
3. **Presentation setup with no deck** — strip shows time and pacing by time only; prompts omit every slide section and still build. Tests in Tasks 8 and 12.
4. **Unreadable input** — a non-zip or password-protected `.pptx` and a scanned PDF with no text: the first fails with a clear `DeckError`, the second imports as `Slide N` image slides. Test in Task 2.
5. **Text inside grouped shapes, tables and fields** (`p:grpSp`, `a:tbl`, `a:fld`) — must appear in the slide body. Test in Task 2.

---

## Phase 1 — Setup kind and deck import

### Task 1: Presentation setup kind

**Files:**
- Modify: `src/setups.js`
- Test: `test/setups.test.js`

**Interfaces:**
- Produces: `KINDS` includes `'presentation'`; `PRESENTATION_DEFAULTS = { durationMin: 45, watchDisplayId: '', deck: null }`; `effectiveSettings(s)` adds `durationMin`, `watchDisplayId`, `deck` (the pointer object or null) when the active setup is a presentation; `setupKind: 'presentation'`. Deck pointer shape: `{ file: string, fileName: string, slideCount: number, importedAt: number }`.

- [ ] **Step 1: Write the failing tests** in `test/setups.test.js`:

```js
test('a presentation setup saves sessions by default and carries its own fields', () => {
  const s = makeSetup({ kind: 'presentation' });
  assert.equal(s.kind, 'presentation');
  assert.equal(s.saveSessions, true);
  assert.equal(s.durationMin, 45);
  assert.equal(s.watchDisplayId, '');
  assert.equal(s.deck, null);
});

test('normalization clamps duration and rejects a deck pointer with a path', () => {
  const out = normalizeSetups({ setups: [
    { id: 'p1', name: 'Lecture', kind: 'presentation', durationMin: 999, deck: { file: '..\\x.json', fileName: 'a.pptx', slideCount: 3, importedAt: 1 } },
    { id: 'p2', name: 'Talk', kind: 'presentation', durationMin: 1, deck: { file: 'p2.json', fileName: 'b.pdf', slideCount: 12, importedAt: 2 } },
    { id: 'g', name: 'Chat', kind: 'general', durationMin: 30, deck: { file: 'g.json' } }
  ] });
  const [, p1, p2, g] = out.setups;
  assert.equal(p1.durationMin, 240);
  assert.equal(p1.deck, null);
  assert.equal(p2.durationMin, 5);
  assert.deepEqual(p2.deck, { file: 'p2.json', fileName: 'b.pdf', slideCount: 12, importedAt: 2 });
  assert.equal('durationMin' in g, false);
  assert.equal('deck' in g, false);
});

test('effective settings expose presentation fields and hide interview-only ones', () => {
  const settings = { setupsVersion: 1, activeSetupId: 'p', setups: [{ id: 'p', name: 'L', kind: 'presentation', whyCompany: 'x', durationMin: 50 }] };
  const e = effectiveSettings(settings);
  assert.equal(e.setupKind, 'presentation');
  assert.equal(e.durationMin, 50);
  assert.equal(e.whyCompany, '');
  assert.equal(e.deck, null);
});

test('a presentation session whose setup was deleted is debriefed as a presentation', () => {
  const e = settingsForSession({ setupsVersion: 1, setups: [] }, { setupId: 'gone', setupName: 'Old lecture', setupKind: 'presentation' });
  assert.equal(e.setupKind, 'presentation');
});
```

- [ ] **Step 2: Run** `node --test test/setups.test.js` — Expected: the four new tests FAIL.

- [ ] **Step 3: Implement in `src/setups.js`.** `makeSetup` adds `PRESENTATION_DEFAULTS` only for `kind === 'presentation'` and defaults `saveSessions` to true for `interview` and `presentation`. `normalizeSetups` copies `durationMin` (`Math.round`, clamp 5..240, non-numbers → 45), `watchDisplayId` (string) and `deck` (kept only if `file` matches `/^[A-Za-z0-9_-]+\.json$/`, `fileName` is a string, `slideCount` is an integer 0..150 and `importedAt` is a number; else null) for presentation setups only. `settingsForSession` picks the stand-in kind as `practice || setupKind === 'interview' || (!setupKind) ? 'interview' : setupKind` restricted to `KINDS`. Keep the existing legacy no-metadata path unchanged.

- [ ] **Step 4: Run** `node --test test/setups.test.js test/store-setups.test.js` — Expected: all PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(setups): presentation setup kind"`

### Task 2: Deck extraction

**Files:**
- Create: `src/deck-extract.js`, `test/deck-extract.test.js`, `test/fixtures/make-deck.js`
- Modify: `package.json` (add `"jszip": "^3.10.1"` to dependencies; run `npm install`)

**Interfaces:**
- Produces:
  - `class DeckError extends Error` (message is user-facing).
  - `async extractDeck(buffer: Buffer, type: 'pptx'|'pdf') -> { slides: Array<{ n, title, body, notes, fingerprint }> }`; throws `DeckError`.
  - `fingerprint(title: string, body: string) -> string` (sha256 hex of `(title + '\n' + body).toLowerCase().replace(/\s+/g, ' ').trim()`).
  - Constants `MAX_SLIDES = 150`, `MAX_FILE_BYTES = 50 * 1024 * 1024`, `BODY_CHARS = 2000`, `NOTES_CHARS = 3000`.
- `test/fixtures/make-deck.js` exports `async makePptx(slides: Array<{ title?, ctrTitle?, body?: string[], notes?, hidden?, xml? }>, { order?: number[] }) -> Buffer` (builds a minimal valid PPTX with jszip: `presentation.xml` with `p:sldIdLst` in `order`, its rels, `slides/slideN.xml`, optional `notesSlides/notesSlideN.xml` with a `sldImg` placeholder, a body placeholder and a `sldNum` placeholder) and `makePdf(pages: string[][]) -> Buffer` (a hand-assembled PDF with one Helvetica text line per string and a correct xref table; an empty array for a page produces a page with no text).

- [ ] **Step 1: Write the failing tests** in `test/deck-extract.test.js`:

```js
test('pptx order follows sldIdLst, not file names, and hidden slides are skipped', async () => {
  const slides = Array.from({ length: 11 }, (_, i) => ({ title: 'T' + (i + 1) }));
  slides[2].hidden = true;
  const buf = await makePptx(slides, { order: [10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11] });
  const { slides: out } = await extractDeck(buf, 'pptx');
  assert.deepEqual(out.map(s => s.title), ['T10', 'T1', 'T2', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T11']);
  assert.deepEqual(out.map(s => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('pptx title, body lines and notes body only', async () => {
  const buf = await makePptx([{ ctrTitle: 'Big-O', body: ['Count steps', '', 'Drop constants'], notes: 'Say the phone book analogy' }]);
  const [s] = (await extractDeck(buf, 'pptx')).slides;
  assert.equal(s.title, 'Big-O');
  assert.equal(s.body, 'Count steps\nDrop constants');
  assert.equal(s.notes, 'Say the phone book analogy');
  assert.equal(s.fingerprint, fingerprint('Big-O', 'Count steps\nDrop constants'));
});

test('text in grouped shapes, tables and fields is extracted', async () => {
  const xml = '<p:grpSp><p:sp><p:txBody><a:p><a:r><a:t>Grouped</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp>' +
    '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>' +
    '<p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>Field</a:t></a:fld></a:p></p:txBody></p:sp>';
  const [s] = (await extractDeck(await makePptx([{ title: 'X', xml }]), 'pptx')).slides;
  assert.equal(s.body, 'Grouped\nCell\nField');
});

test('a slide with no text becomes "Slide N"; long text is truncated', async () => {
  const buf = await makePptx([{ title: 'A' }, {}, { title: 'C', body: ['x'.repeat(2500)], notes: 'y'.repeat(3500) }]);
  const out = (await extractDeck(buf, 'pptx')).slides;
  assert.equal(out[1].title, 'Slide 2');
  assert.equal(out[2].body.length, 2000 + '\n[…truncated]'.length);
  assert.ok(out[2].body.endsWith('\n[…truncated]'));
  assert.equal(out[2].notes.length, 3000 + '\n[…truncated]'.length);
});

test('a non-zip or encrypted pptx fails with a DeckError', async () => {
  await assert.rejects(extractDeck(Buffer.from('D0CF11E0 not a zip'), 'pptx'), (e) => e instanceof DeckError && /not a valid PowerPoint file/.test(e.message));
});

test('more than 150 visible slides fails with a DeckError', async () => {
  const buf = await makePptx(Array.from({ length: 151 }, (_, i) => ({ title: 'S' + i })));
  await assert.rejects(extractDeck(buf, 'pptx'), (e) => e instanceof DeckError && /150/.test(e.message));
});

test('pdf: one slide per page, first line is the title, no notes; a text-less page is an image slide', async () => {
  const out = (await extractDeck(makePdf([['Graphs', 'Nodes and edges'], []]), 'pdf')).slides;
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].title, out[0].body, out[0].notes], ['Graphs', 'Nodes and edges', '']);
  assert.equal(out[1].title, 'Slide 2');
});
```

- [ ] **Step 2: Run** `node --test test/deck-extract.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/deck-extract.js`.** PPTX: `JSZip.loadAsync` (wrap failures as `DeckError('This is not a valid PowerPoint file (it may be password-protected).')`); resolve `p:sldId r:id` through `ppt/_rels/presentation.xml.rels`; skip `<p:sld ... show="0">`; title = text of the `p:sp` whose `p:ph type` is `title` or `ctrTitle`; body = every other `a:p` anywhere in the slide (including `p:grpSp`, `a:tbl`, `a:fld`), each paragraph's `a:t` texts joined, empty paragraphs dropped, joined by `\n`; notes = the notes slide's `p:sp` with `p:ph type="body"` only. Use a small regex-based tag scanner and decode the five XML entities; never follow `TargetMode="External"` rels. PDF: `pdf-parse` with a `pagerender` that returns `getTextContent()` items joined into lines by `transform[5]` changes; collect per page in order. Enforce `MAX_FILE_BYTES` (`DeckError('The deck is larger than 50 MB.')`) and `MAX_SLIDES` (`DeckError('The deck has more than 150 slides.')`).

- [ ] **Step 4: Run** `node --test test/deck-extract.test.js` — Expected: PASS.

- [ ] **Step 5: Commit** `git add package.json package-lock.json src/deck-extract.js test/deck-extract.test.js test/fixtures/make-deck.js && git commit -m "feat(deck): extract slides and notes from PPTX and PDF"`

### Task 3: Deck store

**Files:**
- Create: `src/deck-store.js`, `test/deck-store.test.js`

**Interfaces:**
- Consumes: `createFileStore` from `src/settings-store-core.js`.
- Produces: `class DeckStore { constructor({ dir }); fileFor(setupId) -> string /* '<setupId>.json', setupId validated by /^[A-Za-z0-9_-]+$/ else throws */; load(file) -> Deck | null; save(file, deck); remove(file) }` and `normalizeDeck(raw) -> Deck | null`.
- Deck shape exactly as spec §1 (`version: 1`, `source`, `slides[]` with `n,title,body,notes,fingerprint,points,questions,keyIdea,edited,enrichError`, `matchCache`).

- [ ] **Step 1: Write the failing tests:**

```js
test('save then load round-trips; remove deletes file and .bak', () => { /* tmp dir; save twice so .bak exists; remove; both gone; load -> null */ });
test('a corrupt deck file is recovered from .bak', () => { /* save A, save B, write garbage over main; load -> B's predecessor A */ });
test('normalizeDeck drops bad slides and non-numeric cache entries', () => {
  const d = normalizeDeck({ version: 1, source: { fileName: 'a.pptx', type: 'pptx', sha256: 'x' },
    slides: [{ n: 1, title: 'A', points: ['p', 5] }, 'junk'], matchCache: { abcd: 3, bad: 'x', ['f'.repeat(16)]: 1 } });
  assert.equal(d.slides.length, 1);
  assert.deepEqual(d.slides[0].points, ['p']);
  assert.deepEqual(d.matchCache, { ['f'.repeat(16)]: 1 });
});
test('fileFor rejects ids with path characters', () => assert.throws(() => new DeckStore({ dir: tmp() }).fileFor('../x')));
```

- [ ] **Step 2: Run** `node --test test/deck-store.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** with one `createFileStore(() => dir, file)` per file; `load` returns `normalizeDeck(result.data)`; `remove` unlinks main, `.bak`, `.tmp` quietly. `normalizeDeck` keeps cache keys matching `/^[0-9a-f]{16}$/` with integer values 0..150.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(deck): durable per-setup deck file"`

### Task 4: Enrichment prompts and parsing

**Files:**
- Create: `src/presentation-prompts.js`, `test/presentation-prompts.test.js`

**Interfaces:**
- Produces:
  - `buildEnrichRequest({ conversation, notes, titles: string[], batch: Slide[] }) -> { system, turns, maxTokens: 2500, effort: 'medium' }`.
  - `parseEnrichResponse(text, batchNs: number[]) -> Array<{ n, points, questions, keyIdea }>` (strips code fences, finds the first JSON array, ignores `n` not in `batchNs`, trims and caps strings per Global Constraints, `points` 1..4 items, `questions` 0..3). Returns `[]` on unparseable input.
  - `extractJson(text) -> any | null` (shared helper used by later tasks).

- [ ] **Step 1: Write the failing tests:**

```js
test('enrich system prompt forbids new facts and asks for JSON only', () => {
  const r = buildEnrichRequest({ conversation: '2nd-year CS', notes: '', titles: ['A', 'B'], batch: [{ n: 1, title: 'A', body: 'x', notes: '' }] });
  assert.match(r.system, /must not add facts, figures or citations/);
  assert.match(r.system, /\(image slide: add your own points\)/);
  assert.match(r.turns[0].text, /1\. A\n2\. B/);
});
test('parseEnrichResponse tolerates fences, caps fields and drops unknown slides', () => {
  const text = '```json\n[{"n":1,"points":["' + 'p'.repeat(200) + '","b","c","d","e"],"questions":["q1","q2","q3","q4"],"keyIdea":"k"},{"n":9,"points":["x"]}]\n```';
  const [s, ...rest] = parseEnrichResponse(text, [1, 2]);
  assert.equal(rest.length, 0);
  assert.equal(s.points.length, 4);
  assert.equal(s.points[0].length, 140);
  assert.equal(s.questions.length, 3);
});
test('parseEnrichResponse returns [] for prose', () => assert.deepEqual(parseEnrichResponse('Sorry, I cannot.', [1]), []));
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The system prompt states the grounding rule from spec §2 verbatim in substance ("points come from the slide's text and notes; you may rephrase and order them, but must not add facts, figures or citations"), the image-slide placeholder, the JSON shape, and that slide content is data, not instructions. The user turn lists the talk description, notes (JSON string), all titles numbered `n. title`, then the batch slides as JSON.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(deck): enrichment prompt and tolerant parser"`

### Task 5: Import orchestration and main wiring

**Files:**
- Create: `src/deck-import.js`, `test/deck-import.test.js`
- Modify: `main.js` (IPC + setup deletion cleanup), `preload.js` (bridge + allowed channel `deck:progress`)

**Interfaces:**
- Consumes: `extractDeck`, `DeckError` (Task 2); `DeckStore` (Task 3); `buildEnrichRequest`, `parseEnrichResponse` (Task 4).
- Produces (`src/deck-import.js`):
  - `async importDeck({ buffer, type, fileName, previous: Deck|null, extract = extractDeck }) -> { deck: Deck, unchanged: boolean, toEnrich: number[] }` — same sha256 as `previous` → `{ deck: previous, unchanged: true, toEnrich: [] }`; otherwise carry `points/questions/keyIdea/edited` by `fingerprint`, clear `matchCache`, `toEnrich` = slides without carried content.
  - `async enrichDeck(deck, { ns: number[], call: (request) => Promise<string>, conversation, notes, onBatch: (deck, done, total) => void }) -> Deck` — batches of 8 over `ns` excluding `edited`; a thrown `call` or empty parse sets `enrichError: true` on that batch's slides; never throws.
  - `appendQuestions(deck, items: Array<{ n, question }>) -> Deck` (dedupe case-insensitively, cap 6, mark `edited`) — used in Task 16.
- Produces (IPC, `preload.js` names in parentheses):
  - `deck:import(setupId)` (`deckImport`) → opens dialog filtered to `pptx`, `pdf`; returns `{ canceled } | { error } | { deck: DeckSummary }`; then enriches in the background with `createLLM({ ...settings, smart: true })`, sending `deck:progress { setupId, done, total }` and saving after each batch. It writes the setup's `deck` pointer `{ file, fileName, slideCount, importedAt }` via `updateSetup`.
  - `deck:get(setupId)` (`deckGet`) → full Deck or null.
  - `deck:update-slide(setupId, n, { points, questions, keyIdea })` (`deckUpdateSlide`) → sets `edited: true`, saves.
  - `deck:regenerate(setupId, n | 'unedited')` (`deckRegenerate`) → runs `enrichDeck` for that slide, or all non-edited slides; for a single `n` it first clears `edited` on that slide.
  - On settings save, any setup id that disappeared has its deck file removed.

- [ ] **Step 1: Write the failing tests** in `test/deck-import.test.js`:

```js
test('same file re-import is a no-op', async () => { /* previous.source.sha256 === sha of buffer → unchanged true */ });
test('re-import carries edited content by fingerprint, even when slides move, and clears the cache', async () => {
  // previous: slides A(edited, points ['mine']), B; new extract: B, A, C
  // expect A keeps ['mine'] and edited, toEnrich = [n of C], matchCache {}
});
test('a failed batch marks only its slides and enrichment continues', async () => {
  // 10 slides; call throws on first request, succeeds on second
  // slides 1-8 enrichError true; 9-10 enriched; onBatch called twice with (…, 1, 2) and (…, 2, 2)
});
test('edited slides are never sent for enrichment', async () => { /* call receives batch without edited n */ });
test('appendQuestions dedupes, caps at 6 and marks edited', () => { /* existing 5 + ['Q', 'q', 'new'] → 6, edited true */ });
```

- [ ] **Step 2: Run** `node --test test/deck-import.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement `src/deck-import.js`** per Interfaces (sha256 via `crypto`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Wire `main.js` and `preload.js`** per Interfaces. The `DeckStore` dir is `path.join(app.getPath('userData'), 'decks')`. One enrichment per setup at a time; a new import for the same setup aborts the old one's remaining batches. Errors from `DeckError` return `{ error: e.message }`; other errors return `{ error: 'Could not read ' + fileName + '.' }`.
- [ ] **Step 6: Verify** `npm test` — Expected: all PASS. (The end-to-end import check happens in Task 6, once there is UI to drive it.)
- [ ] **Step 7: Commit** `git commit -m "feat(deck): import, background enrichment and deck IPC"`

### Task 6: Settings UI for presentation setups

**Files:**
- Modify: `renderer/index.html`, `renderer/renderer.js`, `renderer/styles.css`
- Test: `test/renderer-presentation.test.js` (new)

**Interfaces:**
- Consumes: IPC from Task 5; `setupsModel.makeSetup` via preload.
- Produces: renderer helpers (top-level, extractable like `test/renderer-question-box.test.js` does): `parseLines(text) -> string[]` (split on newlines, trim, drop empties) and `deckStatusText({ fileName, slideCount, done, total, failed }) -> string`.

- [ ] **Step 1: Write the failing test** (source-extraction pattern):

```js
test('deck status text', () => {
  const { deckStatusText } = helpers();
  assert.equal(deckStatusText({ fileName: 'l4.pptx', slideCount: 32, done: 3, total: 5 }), 'l4.pptx · 32 slides · Talking points: generating… 3 of 5 batches');
  assert.equal(deckStatusText({ fileName: 'l4.pptx', slideCount: 32, done: 5, total: 5, failed: 2 }), 'l4.pptx · 32 slides · 2 slides not generated');
  assert.equal(deckStatusText({ fileName: 'l4.pptx', slideCount: 32, done: 5, total: 5, failed: 0 }), 'l4.pptx · 32 slides');
});
test('the kind selector offers Presentation', () => {
  assert.match(html, /<button data-kind="presentation" type="button">Presentation<\/button>/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Third kind button. For `presentation`: conversation label "Talk and audience" with placeholder "e.g. Intro to graph algorithms, 2nd-year CS students, comfortable with Python."; interview-only fields hidden as for `general`; new `#setup-duration` number input (5..240), `#setup-display` select (filled in Task 11, hidden for now), deck block with `#deck-import`, `#deck-status`, `#deck-review`. Review opens a list inside Settings: one row per slide `n · title`, expanding to Key idea input, Talking points and Likely questions textareas (one per line, via `parseLines`), per-slide "Generate again", deck-wide "Generate again for unedited slides"; `edited` and `not generated` tags. Saving a row calls `deckUpdateSlide` on blur. Switching kind to presentation with no content ticks `#setup-save`. The setups summary label at `renderer.js:1370` gets `presentation: 'Talk'`. No transitions in CSS.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Manual check.** `npm start` → Settings → New setup → Presentation → import a real 10-slide PPTX → status counts batches → Review slides shows points; edit one slide, re-import the same file (no-op), re-import a modified copy (edited slide kept).
- [ ] **Step 6: Commit** `git commit -m "feat(ui): presentation setups with deck import and slide editor"`

## Phase 2 — Live strip

### Task 7: Display selection for captures

**Files:**
- Modify: `src/screen.js`, `main.js` (`captureHashFrame`)
- Test: `test/screen.test.js`

**Interfaces:**
- Produces: `pickSource(sources, displayId: string, primaryId: string) -> source | null` (match `display_id` to `displayId`, else to `primaryId`, else `sources[0]`, else null); `captureScreenshot({ displayId } = {})`; on macOS pass `-D <1-based index of displayId in screen.getAllDisplays()>` to `screencapture` when `displayId` is set and found. `captureHashFrame({ displayId })` in `main.js` uses `pickSource`. Without `displayId` both behave as today except `captureHashFrame` now prefers primary.

- [ ] **Step 1: Write failing tests** for `pickSource`: exact match, unknown id → primary, no primary match → first, empty → null.
- [ ] **Step 2: Run** `node --test test/screen.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(screen): capture a chosen display"`

### Task 8: Presentation state

**Files:**
- Create: `src/presentation-state.js`, `test/presentation-state.test.js`

**Interfaces:**
- Produces: `createPresentationState({ durationMin, slideCount, now: () => number })` returning:
  - `start()` — sets `startTs` once (idempotent).
  - `setSlide(n, { source: 'match'|'manual' }) -> { left: { n, enterTs, leaveTs, dwellMs } | null }` — ignores `n` outside `1..slideCount` (returns `{ left: null }`); calls `start()`; records skips and flicks; returns the visit just left.
  - `setOffDeck(flag: boolean)`.
  - `addFlag(text)`.
  - `snapshot() -> { current, slideCount, offDeck, remainingMs, pacing: { status: 'on'|'ahead'|'behind'|'none', minutes }, skipped: number[], flags: string[], timeline: Array<{ n, enterTs, leaveTs }> }`.
  - Constants `FLICK_MS = 8000`, `COVERAGE_MIN_DWELL_MS = 20000`, `ON_TRACK_FRACTION = 0.15`.
  - `shouldCheckCoverage(left) -> boolean` (`left.dwellMs >= 20000`).

- [ ] **Step 1: Write failing tests** with a manual clock:

```js
test('on track, ahead and behind follow the ±15% margin', () => {
  // 40 min, 40 slides; at t=10 min on slide 11 → on track; at t=10 min on slide 20 → ahead ≥ 6 min; at t=20 min on slide 5 → behind
});
test('a forward jump marks skipped slides; revisiting clears the skip', () => { /* 1→4 skipped [2,3]; later 2 → skipped [3] */ });
test('a visit under 8 s counts as flicked past, not visited, for pacing', () => {});
test('past the planned end, remaining is 0 and status is behind, never NaN', () => {
  // 5 min talk, now at 9 min on slide 3 of 10 → remainingMs 0, status 'behind', Number.isFinite(minutes)
});
test('no deck: slideCount 0 gives pacing none and ignores setSlide', () => {
  const st = createPresentationState({ durationMin: 45, slideCount: 0, now: () => 0 });
  assert.deepEqual(st.setSlide(1, { source: 'match' }), { left: null });
  assert.equal(st.snapshot().pacing.status, 'none');
});
test('setSlide beyond slideCount is ignored', () => {});
test('coverage is checked only after 20 s dwell', () => {});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** with the pacing algorithm from spec §3: `remainingSlides` = unvisited slides after `current` + 1; `remainingMs = max(0, startTs + durationMs − now)`; `expected = durationMs / slideCount`; `margin = remainingMs − remainingSlides × expected`; `|margin| ≤ 0.15 × durationMs` → `on`; positive → `ahead`; negative → `behind`; `minutes = Math.round(|margin| / 60000)`. Before `start()`, `remainingMs = durationMs` and status `on`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(presentation): pacing, skips and coverage triggers"`

### Task 9: Slide matcher

**Files:**
- Create: `src/deck-match.js`, `test/deck-match.test.js`
- Modify: `src/presentation-prompts.js` (+ tests)

**Interfaces:**
- Consumes: `hammingDistance` from `src/slides.js`; `extractJson` (Task 4).
- Produces:
  - `buildMatchRequest({ slides, hint: number|null }) -> { system, turns, maxTokens: 30, effort: 'low' }` (index lines `n: title | first 80 chars of body`, hint "The presenter was on slide k; slide k+1 is most likely.").
  - `parseMatchResponse(text, slideCount) -> number | null` (`{"slide": n}` with integer 1..slideCount; anything else null).
  - `createMatcher({ getCache: () => object, setCache: (hash, n) => void, slideCount, identify: (hint) => Promise<number|null>, threshold = 5 })` with `async match(hash, hint) -> { n: number|null, cached: boolean }` (null = off-deck; cached values outside `0..slideCount` are a miss) and `correct(hash, n)`.
  - Only one `identify` in flight: a `match` while one is pending waits for it and then re-checks the cache for its own hash; if the pending call was for an older hash, the newer request replaces any other queued one (at most one queued).

- [ ] **Step 1: Write failing tests:** cache hit within distance 5 (no identify call); distance 6 calls identify with the hint; null stored as 0 and returned as `n: null`; cached 40 with `slideCount` 32 is a miss; `correct` overwrites; two rapid `match` calls with three hashes cause at most two identify calls; `parseMatchResponse('{"slide": 7}', 32) === 7`, `parseMatchResponse('slide 7', 32) === null`, `parseMatchResponse('{"slide": 33}', 32) === null`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(presentation): match the screen to a deck slide"`

### Task 10: Live loop wiring and slide shortcuts

**Files:**
- Modify: `src/slides.js` (add `presentationSlidesConfig()`), `src/shortcuts.js`, `main.js`, `preload.js`
- Test: `test/slides.test.js`, `test/shortcuts.test.js`

**Interfaces:**
- Consumes: Tasks 3, 7, 8, 9.
- Produces:
  - `presentationSlidesConfig() -> { enabled: true, intervalMs: 1000, threshold: 5, maxSlides: Infinity, stableRequired: 2 }`.
  - Shortcut actions `{ id: 'slidePrev', label: 'Previous slide (presentation)', defaultAccelerator: 'CommandOrControl+Alt+Left' }`, `{ id: 'slideNext', label: 'Next slide (presentation)', defaultAccelerator: 'CommandOrControl+Alt+Right' }`.
  - Event `presentation:update` (added to preload's allowed list) with `{ snapshot, slide: { n, title, points } | null, next: { n, title } | null, matching: 'ok'|'failed'|'disabled' }`, sent on every slide change and once per second while listening.
  - In `main.js`: `presentationRuntime` = `{ deck, state, matcher } | null`, rebuilt by `loadPresentationRuntime()` whenever the active setup or its deck changes (settings save, import completion) and reset on Clear.

- [ ] **Step 1: Write failing tests:** default shortcuts have no conflicts (`findConflicts(resolveShortcuts()) ` is `[]`) and include both new ids; `presentationSlidesConfig().intervalMs === 1000`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `startSlideTimer` uses `presentationSlidesConfig()` when `currentSettings().setupKind === 'presentation'`; in that mode `pollSlides` skips `captionSlide` and calls `matcher.match(hash, state.snapshot().current)`, where `identify` captures `captureScreenshot({ displayId: settings.watchDisplayId })` and calls `llm.stream` with `buildMatchRequest` (fast model, `STREAM_INACTIVITY_MS` watchdog). Cache writes go to the deck and are saved debounced (2 s). An auth/quota error (same regex as `pollSlides`) sets `matching: 'disabled'` and sends one status toast; other errors set `matching: 'failed'` until the next success. Shortcuts call `state.setSlide(current ± 1, { source: 'manual' })` and `matcher.correct(lastHash, n)`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(presentation): live slide tracking loop and slide shortcuts"`

### Task 11: Presenter strip, toolbar status, display picker, first-use hint

**Files:**
- Modify: `renderer/index.html`, `renderer/renderer.js`, `renderer/styles.css`, `main.js` (`displays:list` IPC), `preload.js`
- Test: `test/renderer-presentation.test.js`

**Interfaces:**
- Consumes: `presentation:update` (Task 10).
- Produces: renderer helpers `formatTimeLeft(ms) -> 'm:ss'` (`0` → `'0:00'`), `pacingChip(pacing) -> string` (`'✓ on track'`, `'▲ ahead 2 min'`, `'▼ behind 4 min'`, `''` for none), `toolbarStatus(update) -> string` (`'7/32 · ✓'`, `'7/32 · ▲'`, `'7/32 · ▼'`, `'off-deck'`, `''` without a deck), `stripStatusLine(update) -> string` (`'Slide 7 / 32 · Big-O intuition'`, `'Slide – / 32'` before the first match, appends `' · off-deck'` or `' · ?'`).

- [ ] **Step 1: Write failing tests** for the four helpers with the exact strings above, including `formatTimeLeft(-5000) === '0:00'`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the strip at the top of `#panel-main` per spec §5: status line + time left + pacing chip; talking points in the largest type in the panel; `next → n · title`; flags line showing the newest flag, click to toggle the full list, hidden when empty; while an answer is displayed, points collapse to the first bullet until the answer is dismissed or `slide.n` changes. Strip shown only for presentation setups. Toolbar pill shows `toolbarStatus` while the panel is collapsed. Settings `#setup-display` filled from `displays:list` (`screen.getAllDisplays()` → `{ id, label: label || 'Display ' + i, width, height }`), shown only with more than one display. First activation of a presentation setup shows once (remembered per setup id in `localStorage`, wrapped in try/catch): "Share a window (your slideshow), not your whole screen, and keep cue on your laptop display." No transitions.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Manual check.** Open a 10-slide deck as a slideshow in a window, start listening with the presentation setup active: slide changes appear within ~2 s on cache hit, `Ctrl+Alt+→` corrects, switching to a browser shows `off-deck`, pacing chip changes over time.
- [ ] **Step 6: Commit** `git commit -m "feat(ui): presenter strip, toolbar status and display picker"`

## Phase 3 — Q&A layer

### Task 12: Presentation context and prompt layer

**Files:**
- Modify: `src/interview-context.js`, `src/prompts.js`
- Create: `src/deck-relevance.js`, `test/deck-relevance.test.js`
- Test: `test/prompts.test.js`

**Interfaces:**
- Consumes: Deck slides (Task 3 shape).
- Produces:
  - `deckOutline(deck) -> string` in `src/deck-relevance.js`: one line per slide `n. title — keyIdea` (` — keyIdea` omitted when empty).
  - `relevantSlides(question, slides, currentN, limit = 3) -> Slide[]`: lowercase word sets minus a fixed English stop-word list, score = shared word count over `title`, `body`, `questions`; excludes `currentN − 1..currentN + 1`; minimum score 2; ties by lower `n`.
  - `buildInterviewContext(settings, mode)` presentation branch, sections in order: `=== This talk and its audience ===` (`jobDescription`), `=== Deck outline ===` (`settings.deckOutline`), `=== Notes for this talk ===` (JSON-string notes with the existing preface), then About me sections as in the general branch.
  - `buildPromptRequest(settings, mode, transcript, userText, session)` accepts `session.slides = { current: Slide|null, neighbours: Slide[], relevant: Slide[] }`; layer = `settings.setupKind === 'presentation' && PRESENTATION_SYSTEMS[mode] ? 'presentation' : (general ? 'general' : 'interview')`; presentation category uses `detectGeneralCategory`.
  - `PRESENTATION_TRANSCRIPT_CHARS = 6000`.

- [ ] **Step 1: Write failing tests:**

```js
test('presentation say prompt is pitched to the audience and carries slide context', () => {
  const settings = { setupKind: 'presentation', jobDescription: '2nd-year CS', deckOutline: '1. Intro\n2. Big-O — Count steps', answerLength: 'brief' };
  const slide = { n: 2, title: 'Big-O', body: 'Count steps', notes: 'phone book', points: ['Drop constants'] };
  const r = buildPromptRequest(settings, 'say', [{ channel: 'them', text: 'Why drop constants?', ts: 1 }], '', { slides: { current: slide, neighbours: [], relevant: [] } });
  assert.match(r.system, /=== Deck outline ===\n1\. Intro\n2\. Big-O — Count steps/);
  assert.match(r.system, /"Them" is the audience/);
  assert.match(r.system, /\(not in your material: verify before stating\)/);
  assert.match(r.turns[0].text, /Current slide \(2\):/);
  assert.ok(r.cachePrefix && r.system.startsWith(r.cachePrefix));
});
test('presentation prompts build without a deck and omit slide sections', () => {
  const r = buildPromptRequest({ setupKind: 'presentation' }, 'say', [{ channel: 'them', text: 'Is this recorded?', ts: 1 }]);
  assert.doesNotMatch(r.system, /Deck outline/);
  assert.doesNotMatch(r.turns[0].text, /Current slide/);
});
test('presentation followup asks check-understanding questions', () => {
  const r = buildPromptRequest({ setupKind: 'presentation' }, 'followup', []);
  assert.match(r.system, /check understanding|questions the presenter could ask the audience/i);
});
test('the presentation transcript window is 6,000 characters', () => { /* 200 long turns; turn text length ≤ 6000 + fixed parts */ });
test('relevantSlides scores shared words, skips neighbours and needs a score of 2', () => {});
```

Also add to the existing interview/general snapshot tests (or add if absent) an assertion that their system and user text for a fixed input equal a stored string captured before this task (`test/fixtures/prompts-before-presentation.json`, generated in Step 0 below).

- [ ] **Step 0: Capture the byte-identical guard.** Before changing `prompts.js`, write `scripts/dev/capture-prompts.js` that builds requests for every mode in both layers for fixed inputs and writes them to `test/fixtures/prompts-before-presentation.json`; commit the fixture with the test that compares against it.
- [ ] **Step 2: Run** — Expected: new tests FAIL, guard PASSES.
- [ ] **Step 3: Implement** `PRESENTATION_SYSTEMS`, `PRESENTATION_BUILDS`, `buildSystemPresentation` and `PRESENTATION_TYPES` with the content of spec §4 (role, the eight types, grounding rules, `answerStyleGeneral`, `SPEECH_TO_TEXT_RULE`); `followup` = 2–3 check-understanding questions about the current slide; `recap` = covered so far by slide plus open audience questions. User turns put slide context before the transcript: `Current slide (n):` (title, body, notes, points), `Neighbouring slides:`, `Possibly relevant slides:`, then `recentTranscript(…, 6000)`, `questionLine`, `callTimeLine`, a presentation checklist line.
- [ ] **Step 4: Run** `npm test` — Expected: PASS, guard unchanged.
- [ ] **Step 5: Commit** `git commit -m "feat(prompts): presentation layer with slide-aware Q&A"`

### Task 13: Q&A wiring and button labels

**Files:**
- Modify: `main.js` (`runFeature`, `currentSettings` consumers), `renderer/renderer.js`
- Test: `test/renderer-presentation.test.js`

**Interfaces:**
- Consumes: Task 12; `presentationRuntime` (Task 10).
- Produces: `runFeature` passes `settings.deckOutline = deckOutline(runtime.deck)` and `session.slides` built from the runtime's current slide, `n ± 1`, and `relevantSlides(question || userText, …)`. Renderer helper `modeLabel(mode, setupKind)` returns `'Answer audience'` for `say` and `'Check understanding'` for `followup` when `setupKind === 'presentation'`, otherwise today's label.

- [ ] **Step 1: Write failing test** for `modeLabel`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** AutoAnswer is unchanged.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Manual check.** In a Zoom test call sharing the slideshow window, a second participant asks a question about the current slide; an answer appears via Auto that references the slide; a question about a later slide yields "I'll get to that on slide N".
- [ ] **Step 6: Commit** `git commit -m "feat(presentation): slide-aware audience answers"`

## Phase 4 — Coverage, sessions, debrief

### Task 14: Coverage checks

**Files:**
- Modify: `src/presentation-prompts.js` (+ tests), `main.js`

**Interfaces:**
- Produces: `buildCoverageRequest({ slide, transcript: string }) -> { system, turns, maxTokens: 80, effort: 'low' }` (transcript capped at 4,000 chars, keeping the end); `parseCoverageResponse(text) -> { status: 'covered'|'partial'|'missed', missing: string } | null` (`missing` cut to 10 words); `coverageFlag(n, result) -> string | null` (`'Slide 4: didn't mention amortized cost'` for partial/missed, null for covered).
- In `main.js`: when `setSlide` returns `left` with `shouldCheckCoverage(left)` and the slide has a `keyIdea`, collect You-channel turns with `ts` in `[enterTs, leaveTs]`, call the fast model async, store the result in `runtime.coverage[n]`, and `state.addFlag(coverageFlag(...))`.

- [ ] **Step 1: Write failing tests:** request includes key idea and points and says a paraphrase counts as covered; transcript of 5,000 chars is cut to its last 4,000; parse of valid JSON, of prose (null), of an unknown status (null); flag text.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(presentation): coverage check when leaving a slide"`

### Task 15: Session presentation block

**Files:**
- Modify: `src/sessions.js`, `main.js`
- Test: `test/sessions.test.js`

**Interfaces:**
- Produces: `SessionRecorder#setPresentation(block)` (stores `session.presentation`, schedules a save; no-op when disabled); block shape exactly spec §6 (`deckFileName, slideCount, durationMin, titles, timeline, coverage, skipped`). `kindLabel` returns `'Presentation'` when `session.setupKind === 'presentation'`. `sessionToMarkdown` inserts `— Slide n · title —` before the first transcript line at or after each `timeline[i].enterTs`; the Type line reads `Presentation`.
- `main.js` calls `setPresentation` on every slide change and coverage result.

- [ ] **Step 1: Write failing tests:** round-trip of the block through `SessionStore`; `kindLabel`/title for a presentation session; Markdown with two timeline entries contains both markers in order relative to transcript lines; a session without the block renders exactly as before.
- [ ] **Step 2: Run** `node --test test/sessions.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(sessions): record the presentation timeline"`

### Task 16: Presentation debrief and questions back into the deck

**Files:**
- Modify: `src/prompts.js`, `main.js` (`sessions:debrief`, new `deck:add-questions`), `preload.js`, `renderer/renderer.js`
- Test: `test/prompts.test.js`, `test/renderer-presentation.test.js`

**Interfaces:**
- Consumes: `appendQuestions` (Task 5); session block (Task 15).
- Produces:
  - `buildPresentationDebriefRequest(settings, session)`, routed from `buildDebriefRequest` when `settings.setupKind === 'presentation'`; sections `## Timing`, `## Coverage`, `## Audience questions`, `## Confusion hotspots`, `## Deck changes for next time` (3–6 edits tied to what happened), then a fenced ```` ```json ```` block `[{"n": 7, "question": "…"}]`. The user turn includes a compact timeline (`n title: m:ss` per visit), coverage and skipped lists, `callLengthLine`, and `sessionTranscriptText`.
  - `splitDebrief(text) -> { prose: string, questions: Array<{ n, question }> }` (questions via `extractJson` on the last fenced json block; prose has that block removed).
  - IPC `deck:add-questions(setupId, items)` (`deckAddQuestions`) → `appendQuestions` + save; returns the updated slide count of questions per `n`.
  - The debrief view shows the prose, then one checkbox per question, "Add to slide n's likely questions", and an "Add selected" button (only when the session's setup still exists and has a deck).

- [ ] **Step 1: Write failing tests:** request lists the five headings in order and the JSON instruction; it forbids inventing questions, times or reactions; `splitDebrief` returns prose without the block and parsed questions; prose with no block returns `questions: []`; interview and general debriefs unchanged (guard fixture from Task 12 extended to debrief builders in this step before implementing).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The saved `session.debrief` stores `prose` only; questions are kept in `session.debriefQuestions`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Manual check.** After the Task 13 test call, open Sessions → the presentation session → Debrief: five sections; tick a question, Add selected; Settings → Review slides shows it under that slide.
- [ ] **Step 6: Update docs.** Add a Presentation row to the README feature table and a section to `docs/fork-changes.md`; mark the spec `Status: implemented`.
- [ ] **Step 7: Commit** `git commit -m "feat(presentation): debrief with timing, coverage and questions back into the deck"`
