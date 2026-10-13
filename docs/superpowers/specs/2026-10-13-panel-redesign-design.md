# Live panel redesign — design

Date: 2026-10-13. Status: approved design, not yet implemented.

## Problem

cue's live panel is crowded and hard to read. Everything lives inside one
fixed, transparent 700x600 window: the toolbar, a floating status label, the
presenter strip, the answers, four action buttons with separators and
shortcut hints, an always-open composer that fills with live speech, five
pill buttons, and a setup bar with prep chips. Settings and Sessions open as
overlays inside the same window. In a live test with a real deck, the
presenter strip squeezed answers to one or two lines, and the panel could not
be made bigger.

## Decisions

| Topic | Decision |
|---|---|
| Scope | The live panel and the window around it. Settings and Sessions content is unchanged. |
| Window model | The window is the panel (approach A). No second window. |
| Size | Resizable from a corner grip; position and size remembered per display |
| Layout | One structure, three zones; narrow below 760 px wide, two-column presenter view from 760 px |
| Answers | The latest answer in large, adjustable type; earlier answers collapsed |
| Live controls kept | Main answer button, Assist, Follow-up / Ask the room, Recap, Smart, Auto |
| Typing | Rare: the composer collapses to an "Ask…" button |
| First-run tutorial | Removed; the publik consent card stays |

Rejected: a separate control bar plus reading window (two protected windows,
double focus and positioning logic; revisit only if answers on another
monitor become a need); decluttering inside the fixed window (keeps the
window-inside-a-window structure and no resizing).

Success criteria:

- An answer is readable from a normal seated distance without leaning in, at
  the default size.
- During live use the panel shows only the controls listed above.
- In presentation setups the talking points never push the answer out of view.
- The window keeps the size the user gave it, per display, across restarts.

## 1. Clean-up

| Element today | Decision |
|---|---|
| First-run tutorial (welcome, permissions, API key, stay hidden, all set) and the logo button that reopens it | Remove. `settings.onboarded` is no longer read. |
| publik API consent card | Keep. Shown on its own, exactly when it is shown today (publik is the provider and the disclosure version is not accepted). |
| "Drag" pill | Remove. The header is the drag region. |
| Hide, start/stop, quit | Keep in the header. Start/stop shows "● Listening" or "Start". |
| Floating `#stt-status` label and `#live-dot` | Remove. |
| Action row separators "•" and inline shortcut hints | Remove separators; shortcut hints move into each button's `title`. |
| Composer (always-open textarea, speech auto-fill) | Collapse to an "Ask…" (✎) button that opens a one-line field. Speech no longer fills it. |
| Speech shown live | A muted one-line "Heard: …" caption with the other side's (Them) latest final line, cut to one line with an ellipsis. Your own speech is not echoed. |
| Smart / Auto pills | Keep as two small toggles in the footer. |
| History, Sessions, Settings icons | Move into a ⋯ menu. |
| Setup switcher, "● saving", About me / Context / Notes chips | Setup name moves into the header (click to switch, same menu as today). "Saving" becomes a small dot after the name with the same tooltip. The prep chips are removed. |
| Category pill and separators between answers | Remove. |
| Toolbar presentation pill (`#tb-presentation`) | Replaced by the header's status when hidden (section 2). |
| Practice row | Keep, unchanged, shown only during practice. |

What "Ask…" sends is unchanged: the typed text goes to the same `ask`
request as the composer today, and Ctrl+Enter (Assist) works without opening
the field.

## 2. Layout

The window content is a single column of three zones. On load and on every
resize the renderer sets `#app` to `.narrow` or `.wide` from
`layoutMode(window.innerWidth)` (`'narrow'` below 760, `'wide'` from 760);
the CSS for each mode does the rest.

### Header (one row, drag region)

Left to right: start/stop ("● Listening" in green / "Start"), the setup name
with ▾ and the saving dot, a flexible gap, the presentation status when a
presentation setup is active (`✓ on track · 18:40`, or `▲`/`▼` with minutes),
Hide, ⋯, ✕. Buttons inside the header are not drag regions.

### Presenter strip (presentation setups only)

- Status line: `Slide n / N · title` (as today, including `off-deck` and `?`).
- Talking points.
- One line combining `next → n · title` and the newest flag (click the flag to
  show all flags, as today).

Narrow: while an answer is shown, the strip keeps only its status line; a ▸
control on that line shows the points again until the next answer or slide
change. Wide: the strip is the left column (40 % of the width, minimum
280 px), never collapses, and the points stay visible.

### Reading area

Takes all remaining height. Shows the latest answer only, in the answer size
(section 3). Below it, "▸ Previous answers (k)" expands an in-place list of
the earlier answers of this conversation, newest first, each with its
question line, in 0.85x the answer size. Streaming, cancel and error states
are shown in the reading area as today. The empty state (no answer yet) is
today's text for the active setup kind.

Wide mode for interview and general setups: a single column whose text is
limited to about 70 characters per line and centred.

Above the footer, the "Heard: …" caption (only while listening and after
the first Them line).

### Footer (one row)

The main answer button (label per setup kind as today: "What should I say?"
or "Answer audience"), Assist, Follow-up ("Ask the room" in presentation
setups), Recap, a flexible gap, Smart, Auto, ✎ Ask. If the row does not fit
(narrow at the minimum width), the three secondary actions turn into
icon-only buttons with their label as `title`; the row never wraps.

The ✎ field opens as one line directly above the footer: Enter sends, Esc
or sending closes it.

### ⋯ menu

A plain list: History, Sessions, Settings, Review slides (presentation setups
only; opens Settings on the deck review), Text size A− / A+ (shows the current
size). Closes on Esc, outside click or choice. No animation.

## 3. Text size

`settings.answerTextPx`, default 18, clamped to 14..32 by `answerScale(size)`.
A− / A+ step by 2. Ctrl+= and Ctrl+- (window-focused shortcuts, not global)
do the same. The value drives CSS custom properties: answer text = size,
talking points = 0.9x, previous answers = 0.85x, captions and header stay
fixed. Stored through the normal settings save; renderer-editable.

## 4. Window behaviour

### Bounds

- First run: 640x560, top-centre of the primary work area (today's spot).
- Minimum 420x300, maximum the work area of the display the window is on.
- `settings.windowBounds = { [displayId]: { x, y, width, height } }`.
  On load, the entry for the display under the saved position is used; if
  the display is gone, the nearest display's work area is used
  (`placeOnDisplay` as today) with the saved size clamped.
- Migration: an existing `windowX`/`windowY` becomes the primary display's
  entry with the default size, then those two fields are removed.
- Bounds are saved (debounced 500 ms) after moves and resizes.
- The code that resets the window to 700x600 on every bounds change is
  removed.
- `windowBounds` is main-owned (added to `RENDERER_READ_ONLY`).

### Resizing

Transparent frameless windows cannot be resized by their edges on Windows,
so the panel has a resize grip in the bottom-right corner. Pointer down on
the grip sends `window:resize-start`; main then polls
`screen.getCursorScreenPoint()` every 16 ms and applies
`clampBounds({ x, y, width: start.width + dx, height: start.height + dy })`
until the renderer sends `window:resize-end` (pointer up or lost capture).

### Hide

Hide shrinks the window to the header's height (width unchanged) and Hide
again restores the saved height. The saved bounds are not overwritten by the
hidden height.

### Overlays

Settings, Sessions and the publik consent card stay overlays inside the
window. When one opens and the window is smaller than 760x640, the window
grows to `growForOverlay(bounds, workArea)` (at least 760x640, kept on the
same display, top-left kept where possible) and returns to the previous
bounds when the overlay closes. The grown size is never saved.

### Click-through

The window now matches the panel, so the transparent area is only the
rounded corners and shadow. The existing click-through mechanism stays for
those, with the UI rectangles reduced to the panel itself.

### Unchanged

Content protection (and `CUE_NO_PROTECT` / `CUE_VISIBLE_TEST`), always on
top, toolbar window type (no Alt+Tab or taskbar), never taking focus,
panel opacity setting, global shortcuts. No animations or transitions.

## 5. Testing

Pure helpers (new `src/panel-layout.js`), unit tested:

- `layoutMode(width)`: 759 → narrow, 760 → wide.
- `clampBounds(bounds, workArea, min = { width: 420, height: 300 })`.
- `boundsForDisplay(windowBounds, displays, legacy)`: per-display pick,
  missing display, legacy `windowX`/`windowY` migration.
- `answerScale(size)`: clamp to 14..32, non-numbers → 18.
- `growForOverlay(bounds, workArea)`.

Renderer source tests (existing extraction pattern):

- The tutorial steps, logo button, drag pill, `#stt-status`, `#live-dot`,
  prep chips and category pill are gone; the publik consent card path remains
  and is shown when consent is pending.
- The ⋯ menu lists History, Sessions, Settings, Text size, and Review slides
  only for presentation setups.
- The footer has one row and no "•" separators.
- No `transition` or `animation` in the new CSS.

Live check (driven on the desktop, as in the presentation test): narrow and
wide layouts with the "Claude for Technical Teams" deck; resize, restart,
same size; Hide and restore; Settings grows a small window and restores it;
an answer at 18 px and at 24 px; interview and general setups still answer.

## 6. Docs

README: remove the "built-in tutorial" sentence and the tutorial screenshot
reference; describe the header, ⋯ menu, resizing and text size. Fork changes:
add a "Live panel redesign" entry.

## New and changed files

New: `src/panel-layout.js`, `test/panel-layout.test.js`.

Changed: `main.js` (bounds, resize IPC, hide height, overlay growth, remove
size reset), `preload.js` (resize and overlay IPC), `src/store.js`
(`windowBounds`, `answerTextPx`, migration), `renderer/index.html`,
`renderer/renderer.js`, `renderer/styles.css`, `test/renderer-*.test.js`,
`README.md`, `docs/fork-changes.md`.
