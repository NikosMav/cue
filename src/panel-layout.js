// Pure window and layout helpers for the live panel. No Electron imports.

const BREAKPOINT = 760;
const MIN_SIZE = { width: 420, height: 300 };
const DEFAULT_SIZE = { width: 640, height: 560 };
const OVERLAY_SIZE = { width: 760, height: 640 };
const TEXT_DEFAULT = 18;
const TEXT_MIN = 14;
const TEXT_MAX = 32;
const TEXT_STEP = 2;

function layoutMode(width) {
  return width >= BREAKPOINT ? 'wide' : 'narrow';
}

// Size clamped to [min, work area], then moved wholly inside the work area.
function clampBounds(bounds, workArea, min = MIN_SIZE) {
  const width = Math.round(Math.min(workArea.width, Math.max(min.width, bounds.width)));
  const height = Math.round(Math.min(workArea.height, Math.max(min.height, bounds.height)));
  const x = Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)));
  const y = Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)));
  return { x, y, width, height };
}

function defaultBounds(workArea) {
  return {
    x: Math.round(workArea.x + (workArea.width - DEFAULT_SIZE.width) / 2),
    y: workArea.y + 6,
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height
  };
}

function distanceTo(point, area) {
  const dx = Math.max(area.x - point.x, 0, point.x - (area.x + area.width));
  const dy = Math.max(area.y - point.y, 0, point.y - (area.y + area.height));
  return Math.hypot(dx, dy);
}

// The display holding the bounds' centre, else the nearest one.
function displayForBounds(bounds, displays) {
  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const list = displays || [];
  return list.find((d) => distanceTo(centre, d.workArea) === 0) ||
    list.reduce((best, d) => (!best || distanceTo(centre, d.workArea) < distanceTo(centre, best.workArea) ? d : best), null);
}

// Used only when Electron reports no displays at all.
const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1280, height: 720 };

function isBounds(b) {
  return !!b && [b.x, b.y, b.width, b.height].every(Number.isFinite);
}

function boundsForDisplay(windowBounds, displays, legacy) {
  const list = (displays || []).filter((d) => d && d.workArea);
  const primary = list[0];
  const areaFor = (b) => {
    const target = displayForBounds(b, list) || primary;
    return target ? target.workArea : FALLBACK_WORK_AREA;
  };
  const saved = windowBounds && typeof windowBounds === 'object' ? windowBounds : {};
  const live = list.find((d) => isBounds(saved[d.id]));
  if (live) return clampBounds(saved[live.id], live.workArea);
  const orphan = Object.values(saved).find(isBounds);
  if (orphan) return clampBounds(orphan, areaFor(orphan));
  if (legacy && Number.isFinite(legacy.windowX) && Number.isFinite(legacy.windowY)) {
    const b = { x: legacy.windowX, y: legacy.windowY, ...DEFAULT_SIZE };
    return clampBounds(b, areaFor(b));
  }
  if (!primary) return clampBounds({ x: 0, y: 0, ...DEFAULT_SIZE }, FALLBACK_WORK_AREA);
  return clampBounds(defaultBounds(primary.workArea), primary.workArea);
}

function answerScale(px) {
  const n = typeof px === 'number' ? px : (typeof px === 'string' && px.trim() !== '' ? Number(px) : NaN);
  if (!Number.isFinite(n)) return TEXT_DEFAULT;
  return Math.min(TEXT_MAX, Math.max(TEXT_MIN, Math.round(n)));
}

function growForOverlay(bounds, workArea) {
  return clampBounds({
    ...bounds,
    width: Math.max(bounds.width, OVERLAY_SIZE.width),
    height: Math.max(bounds.height, OVERLAY_SIZE.height)
  }, workArea);
}

function restoreHeight(saved, current) {
  return { ...current, height: saved.height };
}

module.exports = {
  BREAKPOINT, MIN_SIZE, DEFAULT_SIZE, OVERLAY_SIZE, TEXT_DEFAULT, TEXT_MIN, TEXT_MAX, TEXT_STEP,
  layoutMode, clampBounds, defaultBounds, boundsForDisplay, displayForBounds, answerScale, growForOverlay, restoreHeight
};
