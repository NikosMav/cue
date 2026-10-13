# Live Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cue's live panel resizable, readable and uncluttered: the window becomes the panel, with a header, a reading area showing the latest answer in large adjustable type, a one-row footer, a ⋯ menu, and a two-column presenter view when wide.

**Architecture:** Pure window/layout maths lives in a new `src/panel-layout.js` (unit tested). `main.js` owns window bounds per display, the custom resize grip, hide height and temporary growth for overlays. The renderer is restructured into header / presenter strip / reading area / footer, with `.narrow` / `.wide` classes from the window width; removed features (first-run tour, drag pill, floating status, prep chips, category pill, speech-filled composer) are deleted with their tests.

**Tech Stack:** Electron 44, plain JS renderer, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-13-panel-redesign-design.md`

## Global Constraints

- Work on `main`; commit per task; never push unless asked.
- No animations or transitions anywhere (no new `transition`/`animation` in CSS).
- Unchanged: content protection, `CUE_NO_PROTECT` / `CUE_VISIBLE_TEST`, always on top, toolbar window type, never taking focus, panel opacity setting, global shortcuts, all prompts.
- Breakpoint: `narrow` below 760 px, `wide` from 760 px. Wide presenter column 40 % of the width, minimum 280 px.
- Window: first run 640x560 top-centre of the primary work area; minimum 420x300; maximum the display's work area; overlay growth to at least 760x640.
- Text size `answerTextPx`: default 18, clamp 14..32, step 2; talking points 0.9x, previous answers 0.85x.
- Bounds save debounce 500 ms; resize polling every 16 ms.
- The publik consent card must still appear whenever it does today.
- Settings and Sessions screens keep their content.

## Review Focus

1. **Window saved on a monitor that is now unplugged** — opens on the nearest display, fully on screen, size clamped. Test in Task 1 (`boundsForDisplay`).
2. **Saved size larger than the current display** (laptop after a big monitor) — clamped to the work area. Test in Task 1 (`clampBounds`).
3. **Hide, then resize or open Settings while hidden** — restoring gives back the user's saved height, never the header-only height or the overlay size. Test in Task 1 (`restoreHeight`) and Task 3.
4. **Very long answer at 32 px in a 420x300 window** — reading area scrolls; footer and header stay visible. Source test in Task 5 (`#reading` is the only scrolling zone).
5. **Footer at minimum width** — never wraps; secondary actions go icon-only. Source test in Task 5.

---

### Task 1: Pure layout helpers

**Files:**
- Create: `src/panel-layout.js`, `test/panel-layout.test.js`

**Interfaces:**
- Produces (all pure, exported from `src/panel-layout.js`):
  - Constants `BREAKPOINT = 760`, `MIN_SIZE = { width: 420, height: 300 }`, `DEFAULT_SIZE = { width: 640, height: 560 }`, `OVERLAY_SIZE = { width: 760, height: 640 }`, `TEXT_DEFAULT = 18`, `TEXT_MIN = 14`, `TEXT_MAX = 32`, `TEXT_STEP = 2`.
  - `layoutMode(width: number) -> 'narrow' | 'wide'`.
  - `clampBounds(bounds, workArea, min = MIN_SIZE) -> { x, y, width, height }` — size clamped to `[min, workArea]`, then moved fully inside the work area.
  - `defaultBounds(workArea) -> bounds` — `DEFAULT_SIZE`, horizontally centred, `y = workArea.y + 6`.
  - `boundsForDisplay(windowBounds, displays, legacy) -> bounds` — `windowBounds` is `{ [displayId]: bounds }`; `displays` are Electron-shaped `{ id, workArea }`; `legacy` is `{ windowX, windowY }` or null. Picks the saved entry whose display still exists, preferring the primary (first display); a saved entry for a missing display is moved onto the nearest display's work area; only `legacy` → that position with `DEFAULT_SIZE`; nothing → `defaultBounds(primary.workArea)`. Always returns `clampBounds(...)` of the result.
  - `displayForBounds(bounds, displays) -> display` — display containing the bounds' centre, else nearest.
  - `answerScale(px) -> number` — round to integer, clamp `TEXT_MIN..TEXT_MAX`, non-finite → `TEXT_DEFAULT`.
  - `growForOverlay(bounds, workArea) -> bounds` — width/height at least `OVERLAY_SIZE` (never shrinks), keep `x, y` where possible, then `clampBounds`.
  - `restoreHeight(saved, current) -> bounds` — `{ ...current, height: saved.height }` (used when un-hiding).

- [ ] **Step 1: Write the failing tests** in `test/panel-layout.test.js`:

```js
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const LAPTOP = { id: 1, workArea: WA };
const MONITOR = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

test('layoutMode switches at 760', () => {
  assert.equal(layoutMode(759), 'narrow');
  assert.equal(layoutMode(760), 'wide');
});
test('clampBounds enforces the minimum and keeps the window on the work area', () => {
  assert.deepEqual(clampBounds({ x: 10, y: 10, width: 100, height: 100 }, WA), { x: 10, y: 10, width: 420, height: 300 });
  assert.deepEqual(clampBounds({ x: 1800, y: 900, width: 3000, height: 2000 }, WA), { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(clampBounds({ x: 1700, y: 900, width: 640, height: 560 }, WA), { x: 1280, y: 480, width: 640, height: 560 });
});
test('defaultBounds is 640x560 at the top centre', () => {
  assert.deepEqual(defaultBounds(WA), { x: 640, y: 6, width: 640, height: 560 });
});
test('boundsForDisplay keeps a saved size per display', () => {
  const saved = { 1: { x: 100, y: 50, width: 700, height: 500 }, 2: { x: 2000, y: 100, width: 1100, height: 900 } };
  assert.deepEqual(boundsForDisplay(saved, [LAPTOP, MONITOR], null), saved[1]);
  assert.deepEqual(boundsForDisplay({ 2: saved[2] }, [LAPTOP, MONITOR], null), saved[2]);
});
test('a window saved on an unplugged monitor opens on the nearest display, clamped', () => {
  const b = boundsForDisplay({ 2: { x: 2000, y: 100, width: 2400, height: 1300 } }, [LAPTOP], null);
  assert.ok(b.x >= 0 && b.x + b.width <= 1920 && b.y >= 0 && b.y + b.height <= 1040);
  assert.equal(b.width, 1920);
});
test('legacy windowX/windowY becomes a 640x560 window at that spot', () => {
  assert.deepEqual(boundsForDisplay({}, [LAPTOP], { windowX: 300, windowY: 40 }), { x: 300, y: 40, width: 640, height: 560 });
  assert.deepEqual(boundsForDisplay(null, [LAPTOP], null), defaultBounds(WA));
});
test('answerScale clamps to 14..32 and defaults to 18', () => {
  assert.equal(answerScale(10), 14); assert.equal(answerScale(40), 32); assert.equal(answerScale(21.4), 21);
  assert.equal(answerScale('x'), 18); assert.equal(answerScale(undefined), 18);
});
test('growForOverlay grows small windows to 760x640 and never shrinks big ones', () => {
  assert.deepEqual(growForOverlay({ x: 100, y: 50, width: 500, height: 400 }, WA), { x: 100, y: 50, width: 760, height: 640 });
  assert.deepEqual(growForOverlay({ x: 100, y: 50, width: 1000, height: 900 }, WA), { x: 100, y: 50, width: 1000, height: 900 });
  assert.deepEqual(growForOverlay({ x: 1600, y: 700, width: 500, height: 300 }, WA), { x: 1160, y: 400, width: 760, height: 640 });
});
test('restoreHeight brings back the saved height only', () => {
  assert.deepEqual(restoreHeight({ x: 0, y: 0, width: 640, height: 560 }, { x: 50, y: 60, width: 700, height: 44 }), { x: 50, y: 60, width: 700, height: 560 });
});
```

- [ ] **Step 2: Run** `node --test test/panel-layout.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/panel-layout.js` per Interfaces (no Electron imports; `placeOnDisplay` in `src/click-through.js` may be reused for the nearest-display move).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(panel): pure window and layout helpers"`

### Task 2: Settings fields and migration

**Files:**
- Modify: `src/store.js`
- Test: `test/store-panel.test.js` (new; follow `test/store-setups.test.js` for loading the store without Electron, or test the pure pieces it exports)

**Interfaces:**
- Produces: settings `windowBounds: {}` (default) and `answerTextPx: 18` (default); `windowBounds` added to `RENDERER_READ_ONLY` and stripped from renderer patches like `windowX`/`windowY`; `answerTextPx` renderer-editable and normalised with `answerScale`. `windowX`/`windowY` stay readable for the one-time migration in Task 3 (they are deleted by main after migrating).

- [ ] **Step 1: Write failing tests:** defaults present; a renderer patch with `windowBounds` is ignored; `answerTextPx: 40` saves as 32 and `'big'` as 18.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/store-panel.test.js test/store-setups.test.js test/store-publik.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(panel): window bounds and text size settings"`

### Task 3: Window bounds, resize grip, hide height and overlay growth (main + preload)

**Files:**
- Modify: `main.js` (`createWindow`, `saveWindowPosition`, the `moved` handlers ~424-431, hide), `preload.js`
- Test: `test/main-window.test.js` (new, source-inspection like `test/renderer-presentation.test.js`)

**Interfaces:**
- Consumes: Task 1 helpers; Task 2 settings.
- Produces IPC (preload names in parentheses):
  - `window:resize-start` (`resizeStart()`), `window:resize-end` (`resizeEnd()`) — main polls `screen.getCursorScreenPoint()` every 16 ms between them and applies `clampBounds({ ...start, width: start.width + dx, height: start.height + dy }, display.workArea)`.
  - `window:set-hidden` (`setHidden(hidden: boolean, headerHeight: number)`) — hidden: window height becomes `headerHeight`; shown: `restoreHeight(saved, current)`.
  - `window:overlay` (`setOverlay(open: boolean)`) — open: `growForOverlay(current, workArea)` without saving; close: back to the bounds before growth.
- Behaviour:
  - `createWindow` uses `boundsForDisplay(settings.windowBounds, screen.getAllDisplays(), { windowX, windowY })`; after a legacy migration main saves `windowBounds` and clears `windowX`/`windowY`.
  - `moved` and `resized` save `windowBounds[displayForBounds(b).id] = b` debounced 500 ms, except while hidden or grown for an overlay.
  - The handler that reset the size to 700x600 on every move is removed.
  - Click-through UI rects keep working (the renderer still reports them).

- [ ] **Step 1: Write failing source tests:** `main.js` no longer contains `width: W, height: H` resets in a `moved` handler; it requires `./src/panel-layout`; registers `window:resize-start`, `window:resize-end`, `window:set-hidden`, `window:overlay`; preload exposes `resizeStart`, `resizeEnd`, `setHidden`, `setOverlay`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep hidden/overlay state in main (`windowState = { hidden, overlayRestore }`) so saves skip those sizes.
- [ ] **Step 4: Run** `npm test` and `node --check main.js preload.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(panel): resizable window remembered per display"`

### Task 4: Remove the first-run tour and toolbar clutter; header and ⋯ menu

**Files:**
- Modify: `renderer/index.html`, `renderer/renderer.js`, `renderer/styles.css`
- Test: `test/renderer-panel.test.js` (new)

**Interfaces:**
- Produces: header `#header` (drag region) containing `#stop-btn` (label "● Listening" / "Start"), `#setup-switch` with `#setup-saving-dot`, `#header-status` (presentation status, replaces `#tb-presentation`), `#hide-btn`, `#menu-btn`, `#quit-btn`; menu `#panel-menu` with items `data-action="history" | "sessions" | "settings" | "review-slides" | "text-smaller" | "text-larger"` and a `#text-size-value` label. Hide calls `cue.setHidden(collapsed, headerHeight)`.
- Removes: `#onboard-scrim` tour steps and `showOnboard`/logo button (keep the publik card path: when publik consent is pending, the card shows on its own exactly as `showPublikCard` does after onboarding today), drag pill, `#live-dot`, `#stt-status`, `#tb-presentation`, `#prep-status` chips (`.prep-item`), the composer-bottom History/Sessions/Settings icons.

- [ ] **Step 1: Write failing source tests:** none of `id="onboard-scrim"` step markup, `logo-btn`, `drag-pill`, `id="live-dot"`, `id="stt-status"`, `class="prep-item"`, `tb-presentation` remain in `index.html`; `renderer.js` has no `OB_STEPS`; the publik card still renders when `publik.disclosureAccepted < disclosureVersion` (assert the function that decides this still exists and is called on boot); `#panel-menu` contains the six actions; `review-slides` is hidden unless the active setup is a presentation; `text-smaller`/`text-larger` step by `TEXT_STEP` within `TEXT_MIN..TEXT_MAX` and save `answerTextPx`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Menu: plain list, closes on Esc, outside click or choice. Text size sets CSS custom property `--answer-px` on `#app`. Ctrl+= / Ctrl+- handled as window keydown (not global shortcuts). Update `UI_SELECTORS` to the new elements.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (delete or update tests that covered removed elements).
- [ ] **Step 5: Commit** `git commit -m "feat(panel): header and menu; remove the first-run tour and toolbar clutter"`

### Task 5: Reading area, footer, Ask field and Heard caption

**Files:**
- Modify: `renderer/index.html`, `renderer/renderer.js`, `renderer/styles.css`
- Modify/Delete tests: `test/renderer-question-box.test.js` (speech-fill tests removed with the feature), `test/renderer-panel.test.js`

**Interfaces:**
- Produces: `#reading` (the only scrolling zone) showing the latest `.response-group`; `#previous-toggle` ("▸ Previous answers (k)") expanding `#previous-list` (earlier groups, newest first, 0.85x size); footer `#action-row` (one row, `flex-wrap: nowrap`, no `.sep`; `.compact` class makes the three secondary actions icon-only when the row would overflow); `#ask-btn` toggles `#ask-field` (one-line input above the footer; Enter sends via the existing ask path, Esc or send closes); `#heard` caption showing the latest final Them line while listening, one line with ellipsis.
- Removes: the always-open textarea composer, speech auto-fill (`latestSpeech`, `stt-filling` states), category pill, `.response-sep`, `.user-bubble` above the latest answer is kept as a one-line muted question.

- [ ] **Step 1: Write failing source tests:** `#reading` has `overflow-y: auto` and header/footer are `flex: 0 0 auto`; `#action-row` has `flex-wrap: nowrap` and no `.sep` in markup; no `category-pill` or `response-sep` created in `renderer.js`; no `stt-filling` class used; answer text uses `var(--answer-px)`; previous answers use `calc(var(--answer-px) * 0.85)`; `#heard` is updated only from Them finals.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Shortcut hints move into each button's `title`. Main answer button label keeps `modeLabel()`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(panel): reading area, one-row footer, Ask field and heard caption"`

### Task 6: Presenter strip modes, wide layout, resize grip and overlays

**Files:**
- Modify: `renderer/index.html`, `renderer/renderer.js`, `renderer/styles.css`
- Test: `test/renderer-presentation.test.js`, `test/renderer-panel.test.js`

**Interfaces:**
- Consumes: Task 1 `layoutMode`, `BREAKPOINT`; Task 3 IPC.
- Produces:
  - `#app.narrow` / `#app.wide` from `layoutMode(window.innerWidth)` on load and `resize`.
  - Wide + presentation: `#panel-body` becomes two columns, strip left (`flex: 0 0 40%; min-width: 280px`), reading right; points never collapse.
  - Narrow: while an answer is shown the strip keeps only its status line (existing `.answering`), with a `#ps-expand` ▸ that shows the points until the next answer or slide change.
  - Wide + interview/general: reading text `max-width: 70ch; margin: 0 auto`.
  - `next` and the newest flag share one line (`#ps-meta`).
  - `#resize-grip` (bottom-right) calls `cue.resizeStart()` on pointerdown and `cue.resizeEnd()` on pointerup/lostpointercapture.
  - Opening Settings, Sessions or the publik card calls `cue.setOverlay(true)`; closing calls `cue.setOverlay(false)`.
  - The History sidebar opens as an overlay drawer inside the panel (right side, full height, over the reading area) — it no longer floats outside the panel.
  - `visiblePoints(points, answerShown, mode)`: wide → all points; narrow + answer → `[]`.

- [ ] **Step 1: Write failing tests:** `visiblePoints(['a','b'], true, 'wide')` → `['a','b']`; `visiblePoints(['a','b'], true, 'narrow')` → `[]`; source tests for `#resize-grip` handlers, `setOverlay(true/false)` calls in `openSettings`/`closeSettings`/`openSessions`/`closeSessions`, the 40 %/280 px rule and `70ch`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; `node --check renderer/renderer.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(panel): presenter view, resize grip and overlay growth"`

### Task 7: Docs and live check

**Files:**
- Modify: `README.md`, `docs/fork-changes.md`, spec `Status: implemented`

- [ ] **Step 1:** README: remove the "built-in tutorial … cue logo" sentence and the `docs/tutorial.png` image; describe the header, ⋯ menu, resizing and text size (Ctrl+= / Ctrl+-). Fork changes: "Live panel redesign" entry.
- [ ] **Step 2: Live check** (controller, driving the desktop with `CUE_NO_PROTECT=1`): narrow and wide with the "Claude for Technical Teams" deck; resize, restart, same size; Hide and restore; Settings grows a small window and restores it; answers readable at 18 px and 24 px; interview and general setups answer; publik card still reachable (Settings → Keys → publik when consent is pending).
- [ ] **Step 3: Commit** `git commit -m "docs: live panel redesign"`
