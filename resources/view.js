let dpr = window.devicePixelRatio || 1;
let cssW = 0, cssH = 0;

const ZOOM_STOPS = [2, 3, 4, 5, 6, 8, 11, 15, 21, 30];
const MIN_ZOOM = ZOOM_STOPS[0];
const ZOOM_SENSITIVITY = 3.5;	// fractional levels per unit log(pinch factor)
let zoomIdx = 0;
let zoom = MIN_ZOOM;

let camX = 0, camY = 0;

let curX = 0, curY = 0;
// used to keep the brush pinned under the real cursor while panning, since
// the OS does not emit pointermove events when only the camera moves.
let curClientX = null, curClientY = null;
let mouseInside = false;
let cursorAlpha = 0;
let cursorFadeFrom = 0;
let cursorFadeTo = 0;
let cursorFadeStart = 0;
const CURSOR_FADE_IN_MS = 100;
const CURSOR_FADE_OUT_MS = 400;
function setCursorFadeTarget(target) {
	if (target === cursorFadeTo) return;
	cursorFadeFrom = cursorAlpha;
	cursorFadeTo = target;
	cursorFadeStart = performance.now();
	requestDraw();
}
function showCursor() {
	mouseInside = true;
	setCursorFadeTarget(1);
}
function hideCursorNow() {
	mouseInside = false;
	cursorAlpha = 0;
	cursorFadeFrom = 0;
	cursorFadeTo = 0;
}

function resize() {
	const firstResize = cssW === 0;
	dpr = window.devicePixelRatio || 1;
	cssW = window.innerWidth;
	cssH = window.innerHeight;
	view.style.width = cssW + 'px';
	view.style.height = cssH + 'px';
	view.width = Math.floor(cssW * dpr);
	view.height = Math.floor(cssH * dpr);
	if (firstResize) {
		curX = Math.floor(cssW / (2 * zoom));
		curY = Math.floor(cssH / (2 * zoom));
	}
	requestDraw();
}

function clientToWorld(clientX, clientY) {
	const lx = Math.floor(clientX / zoom + camX);
	const ly = Math.floor(clientY / zoom + camY);
	return { x: lx, y: ly };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function applyZoom(factor, ax, ay) {
	const worldAtAnchorX = camX + ax / zoom;
	const worldAtAnchorY = camY + ay / zoom;
	zoomIdx = clamp(zoomIdx + Math.log(factor) * ZOOM_SENSITIVITY, 0, ZOOM_STOPS.length - 1);
	const newZoom = ZOOM_STOPS[Math.round(zoomIdx)];
	if (newZoom !== zoom) {
		zoom = newZoom;
		camX = worldAtAnchorX - ax / zoom;
		camY = worldAtAnchorY - ay / zoom;
	}
}

function zoomTo(newZoom) {
	if (newZoom === zoom) return;
	const ax = cssW / 2, ay = cssH / 2;
	const worldAtAnchorX = camX + ax / zoom;
	const worldAtAnchorY = camY + ay / zoom;
	zoom = newZoom;
	zoomIdx = ZOOM_STOPS.indexOf(zoom);
	camX = worldAtAnchorX - ax / zoom;
	camY = worldAtAnchorY - ay / zoom;
	requestDraw();
}

function stepZoom(dir) {
	const i = ZOOM_STOPS.indexOf(zoom);
	zoomTo(ZOOM_STOPS[clamp(i + dir, 0, ZOOM_STOPS.length - 1)]);
}
function resetZoom() { zoomTo(MIN_ZOOM); }
