// Click-through for the transparent overlay window, decided in the main process.
//
// The window ignores the mouse wherever it is transparent, so the app behind
// stays usable, and takes the mouse over its UI. That used to be decided in
// the renderer from mousemove events that Windows forwards while the window
// ignores the mouse. Those arrive unreliably, and never over a
// -webkit-app-region: drag area (the whole toolbar): a pointer that reached
// the Drag handle directly left the window click-through, and the press went
// to the app behind instead of starting a drag. Here the main process polls
// the cursor against the UI rectangles the renderer reports, so no forwarded
// event is needed.

const POLL_MS = 25;

function inside(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

// point: cursor in screen DIP. bounds: window bounds in screen DIP. rects: UI
// rectangles in window (CSS px = DIP) coordinates.
function interactiveAt(point, bounds, rects) {
  if (!point || !bounds || !inside(point, bounds)) return false;
  const local = { x: point.x - bounds.x, y: point.y - bounds.y };
  return (rects || []).some((rect) => inside(local, rect));
}

function createClickThrough({ getCursor, getBounds, setIgnore, isActive = () => true, intervalMs = POLL_MS }) {
  let rects = [];
  let ignoring = null;
  let timer = null;

  function tick() {
    if (!isActive()) return;
    const ignore = !interactiveAt(getCursor(), getBounds(), rects);
    if (ignore !== ignoring) {
      ignoring = ignore;
      setIgnore(ignore);
    }
  }

  return {
    tick,
    // A layout change (dialog opened, panel hidden) applies at once, not at the next poll.
    setRects(next) { rects = Array.isArray(next) ? next : []; tick(); },
    start() { if (!timer) timer = setInterval(tick, intervalMs); },
    stop() { clearInterval(timer); timer = null; }
  };
}

// Keep at least this much of the window on screen.
const MIN_VISIBLE_PX = 100;
const MIN_VISIBLE_TOP_PX = 40;

function distanceTo(point, area) {
  const dx = Math.max(area.x - point.x, 0, point.x - (area.x + area.width));
  const dy = Math.max(area.y - point.y, 0, point.y - (area.y + area.height));
  return Math.hypot(dx, dy);
}

// Where to put the window for a saved top-left position: on the display that
// holds the toolbar (top centre of the window), or the nearest one if that
// monitor is gone, clamped so the toolbar stays reachable. Clamping against
// the primary display alone pulled a window saved on a secondary monitor
// back across to the primary at the next launch.
function placeOnDisplay(saved, size, displays) {
  const anchor = { x: saved.x + size.width / 2, y: saved.y + 20 };
  const areas = (displays || []).map((d) => d.workArea).filter(Boolean);
  if (!areas.length) return { x: saved.x, y: saved.y };
  const area = areas.find((a) => inside(anchor, a)) ||
    areas.reduce((best, a) => (distanceTo(anchor, a) < distanceTo(anchor, best) ? a : best));
  return {
    x: Math.round(Math.max(area.x - size.width + MIN_VISIBLE_PX, Math.min(saved.x, area.x + area.width - MIN_VISIBLE_PX))),
    y: Math.round(Math.max(area.y, Math.min(saved.y, area.y + area.height - MIN_VISIBLE_TOP_PX)))
  };
}

module.exports = { interactiveAt, createClickThrough, placeOnDisplay, POLL_MS };
