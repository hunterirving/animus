window.addEventListener('resize', resize);

// mouse and pen share the pointer-event path; finger touches are handled
// by the touch-event path below
function hoverPointer(e) { return e.pointerType === 'mouse' || e.pointerType === 'pen'; }

window.addEventListener('pointerover', (e) => {
	if (!hoverPointer(e)) return;
	showCursor();
	curClientX = e.clientX;
	curClientY = e.clientY;
	const p = clientToWorld(e.clientX, e.clientY);
	curX = p.x;
	curY = p.y;
	requestDraw();
});

// brush resize curve: linear (fine, precise) up to BRUSH_LINEAR_MAX, then a
// power-law ramp beyond, tuned by BRUSH_ACCEL.
function brushFromDrag(start, dyPx) {
	const A = BRUSH_DRAG_PX_PER_STEP, T = BRUSH_LINEAR_MAX, c = BRUSH_ACCEL;
	const seam = T * A; // drag distance from size 0 to the seam
	const brushToPos = (b) => b <= T ? b * A : seam + (seam / c) * (Math.pow(b / T, c) - 1);
	const posToBrush = (p) => p <= seam ? p / A : T * Math.pow(1 + c * (p - seam) / seam, 1 / c);
	return posToBrush(brushToPos(start) + dyPx);
}

// modifier-drag: shift/cmd/RGB held -> vertical motion from the anchor
// drives brush size / roundness / color channels. drag up (dy negative)
// -> increase. when a value hits its bound and the drag continues past,
// re-anchor so reversing direction responds immediately. each drag is
// independent so any combination can run at once.
function applyDrags(clientY) {
	if (dragBrush) {
		const dyPx = (dragBrush.anchorY - clientY) * dpr;
		const target = brushFromDrag(dragBrush.start, dyPx);
		const clamped = clamp(Math.round(target), 1, MAX_BRUSH);
		brush = clamped;
		if (target < 1 || target > MAX_BRUSH) {
			dragBrush.start = clamped;
			dragBrush.anchorY = clientY;
		}
	}
	if (dragRoundness) {
		const dyPx = (dragRoundness.anchorY - clientY) * dpr;
		const target = dragRoundness.start - dyPx / ROUNDNESS_DRAG_FULL_PX;
		const clamped = clamp(target, 0, 1);
		roundness = clamped;
		if (target !== clamped) {
			dragRoundness.start = clamped;
			dragRoundness.anchorY = clientY;
		}
	}
	if (dragColor) {
		const dyPx = (dragColor.anchorY - clientY) * dpr;
		const delta = (dyPx / COLOR_DRAG_FULL_PX) * 255;
		let nr = r, ng = g, nb = b;
		let overshoot = 0;
		if (keys['r']) {
			const t = dragColor.r0 + delta;
			nr = clamp(t, 0, 255);
			if (t !== nr) overshoot = Math.max(overshoot, Math.abs(t - nr));
		}
		if (keys['g']) {
			const t = dragColor.g0 + delta;
			ng = clamp(t, 0, 255);
			if (t !== ng) overshoot = Math.max(overshoot, Math.abs(t - ng));
		}
		if (keys['b']) {
			const t = dragColor.b0 + delta;
			nb = clamp(t, 0, 255);
			if (t !== nb) overshoot = Math.max(overshoot, Math.abs(t - nb));
		}
		setColor(Math.round(nr), Math.round(ng), Math.round(nb));
		if (overshoot > 0) {
			dragColor.r0 = nr; dragColor.g0 = ng; dragColor.b0 = nb;
			dragColor.anchorY = clientY;
		}
	}
}

window.addEventListener('pointermove', (e) => {
	if (!hoverPointer(e)) return;
	// a pen only proves it can hover by moving while lifted. without hover
	// it gets the finger treatment: modifiers adjust instead of marking
	if (e.pointerType === 'pen' && e.buttons === 0) penHover = true;
	showCursor();
	curClientX = e.clientX;
	curClientY = e.clientY;
	const p = clientToWorld(e.clientX, e.clientY);
	const nx = p.x, ny = p.y;

	applyDrags(e.clientY);

	if (painting) {
		if (lastPaintX !== null) {
			localPaintLine(lastPaintX, lastPaintY, nx, ny);
		} else {
			localPaintAt(nx, ny);
		}
		lastPaintX = nx;
		lastPaintY = ny;
	} else if (picking) {
		pickAt(nx, ny);
	}
	curX = nx;
	curY = ny;
	requestDraw();
});

window.addEventListener('pointerleave', (e) => {
	if (!hoverPointer(e)) return;
	hideCursorNow();
	requestDraw();
});

// a pen without hover support sends no move events before contact, so the
// down event must place the cursor itself
let penDown = false;
let penHover = false;
window.addEventListener('pointerdown', (e) => {
	if (!hoverPointer(e)) return;
	if (e.button !== 0) return;
	e.preventDefault();
	stopInertia();
	if (e.pointerType === 'pen') penDown = true;
	showCursor();
	curClientX = e.clientX;
	curClientY = e.clientY;
	const p = clientToWorld(e.clientX, e.clientY);
	curX = p.x;
	curY = p.y;
	// hoverless pen + modifier held -> the contact adjusts, like a finger
	if (e.pointerType === 'pen' && !penHover && !keys['c'] && (dragBrush || dragRoundness || dragColor)) {
		anchorDrags(e.clientY);
		requestDraw();
		return;
	}
	if (keys['c']) {
		picking = true;
		pickAt(curX, curY);
		requestDraw();
		return;
	}
	painting = true;
	lastPaintX = curX;
	lastPaintY = curY;
	localPaintAt(curX, curY);
	requestDraw();
});

function pointerUp(e) {
	if (!hoverPointer(e)) return;
	if (e.button === 0 || e.type === 'pointercancel') {
		painting = false;
		picking = false;
		lastPaintX = null;
		lastPaintY = null;
		if (e.pointerType === 'pen') {
			penDown = false;
			// hoverless pens get no more events after lift, so fade like touch
			if (mouseInside) setCursorFadeTarget(0);
			requestDraw();
		}
	}
}
window.addEventListener('pointerup', pointerUp);
window.addEventListener('pointercancel', pointerUp);

// touch: one finger paints, two fingers pan/pinch-zoom. once a second
// finger lands the whole touch becomes a gesture (no painting) until all
// fingers lift, so a stray finger during a pan never leaves a mark.
// stylus touches are excluded here
let touchMode = null; // 'paint' | 'adjust' | 'gesture'
let touchPainted = false;
let pinchDist = 0, pinchMidX = 0, pinchMidY = 0;

// inertial pan: centroid velocity (css px/ms) tracked during the gesture,
// thrown on release and decayed with exponential friction
let panVX = 0, panVY = 0;
let panLastT = 0;
let inertiaRAF = null;
function stopInertia() {
	if (inertiaRAF !== null) {
		cancelAnimationFrame(inertiaRAF);
		inertiaRAF = null;
	}
}
function startInertia() {
	// no throw if the finger paused before lifting or was barely moving
	const speed = Math.hypot(panVX, panVY);
	if (performance.now() - panLastT > 100 || speed < 0.05) return;
	// exponential decay per ms
	const DECEL = 0.995;
	const MAX_SPEED = 3; // css px/ms
	if (speed > MAX_SPEED) {
		panVX *= MAX_SPEED / speed;
		panVY *= MAX_SPEED / speed;
	}
	let prev = performance.now();
	const step = (now) => {
		const dt = now - prev;
		prev = now;
		camX -= panVX * dt / zoom;
		camY -= panVY * dt / zoom;
		const f = Math.pow(DECEL, dt);
		panVX *= f;
		panVY *= f;
		requestDraw();
		inertiaRAF = Math.hypot(panVX, panVY) > 0.02 ? requestAnimationFrame(step) : null;
	};
	inertiaRAF = requestAnimationFrame(step);
}

function touchCentroid(touches) {
	let x = 0, y = 0;
	for (const t of touches) { x += t.clientX; y += t.clientY; }
	return { x: x / touches.length, y: y / touches.length };
}

function fingerTouches(list) {
	const out = [];
	for (const t of list) if (t.touchType !== 'stylus') out.push(t);
	return out;
}

// re-anchor active drags to a new y and re-baseline to the current values
// so successive drag strokes accumulate instead of snapping back
function anchorDrags(clientY) {
	if (dragBrush) { dragBrush.anchorY = clientY; dragBrush.start = brush; }
	if (dragRoundness) { dragRoundness.anchorY = clientY; dragRoundness.start = roundness; }
	if (dragColor) { dragColor.anchorY = clientY; dragColor.r0 = r; dragColor.g0 = g; dragColor.b0 = b; }
}

function anchorGesture(touches) {
	const m = touchCentroid(touches);
	pinchMidX = m.x;
	pinchMidY = m.y;
	pinchDist = touches.length >= 2
		? Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
		: 0;
}

window.addEventListener('touchstart', (e) => {
	e.preventDefault();
	const fingers = fingerTouches(e.touches);
	// fingers are ignored while the pen is down so a resting hand can't
	// hijack or extend the pen's stroke
	if (fingers.length === 0 || penDown) return;
	stopInertia();
	if (fingers.length === 1 && touchMode === null) {
		const t = fingers[0];
		curClientX = t.clientX;
		curClientY = t.clientY;
		if (!keys['c'] && (dragBrush || dragRoundness || dragColor)) {
			touchMode = 'adjust';
			const p = clientToWorld(t.clientX, t.clientY);
			curX = p.x;
			curY = p.y;
			showCursor();
			anchorDrags(t.clientY);
		} else {
			const p = clientToWorld(t.clientX, t.clientY);
			curX = p.x;
			curY = p.y;
			showCursor();
			touchMode = 'paint';
			touchPainted = false;
			if (keys['c']) {
				picking = true;
			} else {
				painting = true;
				lastPaintX = curX;
				lastPaintY = curY;
			}
		}
	} else {
		touchMode = 'gesture';
		painting = false;
		picking = false;
		lastPaintX = null;
		lastPaintY = null;
		hideCursorNow();
		panVX = 0;
		panVY = 0;
		panLastT = 0;
		anchorGesture(fingers);
	}
	requestDraw();
}, { passive: false });

window.addEventListener('touchmove', (e) => {
	e.preventDefault();
	const fingers = fingerTouches(e.touches);
	if (fingers.length === 0) return;
	if (touchMode === 'paint') {
		const t = fingers[0];
		curClientX = t.clientX;
		curClientY = t.clientY;
		// on hover devices held keys adjust during the stroke, like mouse
		applyDrags(t.clientY);
		const p = clientToWorld(t.clientX, t.clientY);
		if (picking) {
			pickAt(p.x, p.y);
		} else if (painting) {
			localPaintLine(lastPaintX, lastPaintY, p.x, p.y);
			lastPaintX = p.x;
			lastPaintY = p.y;
		}
		touchPainted = true;
		curX = p.x;
		curY = p.y;
	} else if (touchMode === 'adjust') {
		const t = fingers[0];
		curClientX = t.clientX;
		curClientY = t.clientY;
		applyDrags(t.clientY);
		const p = clientToWorld(t.clientX, t.clientY);
		curX = p.x;
		curY = p.y;
	} else if (touchMode === 'gesture') {
		const m = touchCentroid(fingers);
		const dxs = m.x - pinchMidX;
		const dys = m.y - pinchMidY;
		camX -= dxs / zoom;
		camY -= dys / zoom;
		const nowT = performance.now();
		const dt = nowT - panLastT;
		if (dt > 0 && dt < 100) {
			panVX = panVX * 0.5 + (dxs / dt) * 0.5;
			panVY = panVY * 0.5 + (dys / dt) * 0.5;
		}
		panLastT = nowT;
		if (fingers.length >= 2) {
			const dist = Math.hypot(fingers[0].clientX - fingers[1].clientX, fingers[0].clientY - fingers[1].clientY);
			if (pinchDist > 0) applyZoom(dist / pinchDist, m.x, m.y);
			pinchDist = dist;
		}
		pinchMidX = m.x;
		pinchMidY = m.y;
	} else {
		return;
	}
	requestDraw();
}, { passive: false });

function touchEnd(e) {
	e.preventDefault();
	if (touchMode === null) return;
	const fingers = fingerTouches(e.touches);
	if (fingers.length === 0) {
		// a tap that never moved still paints its dot (or picks its point)
		if (touchMode === 'paint' && !touchPainted) {
			if (picking) pickAt(curX, curY);
			else localPaintAt(curX, curY);
		}
		if (touchMode === 'gesture') startInertia();
		touchMode = null;
		painting = false;
		picking = false;
		lastPaintX = null;
		lastPaintY = null;
		// fade the preview out instead of hiding it instantly
		if (mouseInside) setCursorFadeTarget(0);
		requestDraw();
	} else if (touchMode === 'gesture') {
		// re-anchor to the remaining fingers so the camera doesn't jump
		anchorGesture(fingers);
	}
}
window.addEventListener('touchend', touchEnd, { passive: false });
window.addEventListener('touchcancel', touchEnd, { passive: false });

function startDragMode(mode) {
	const anchorY = curClientY !== null ? curClientY : 0;
	if (mode === 'brush' && !dragBrush) dragBrush = { anchorY, start: brush };
	else if (mode === 'roundness' && !dragRoundness) dragRoundness = { anchorY, start: roundness };
	else if (mode === 'color' && !dragColor) dragColor = { anchorY, r0: r, g0: g, b0: b };
	// hoverless input: a modifier pressed mid-stroke ends the stroke and
	// the rest of the contact becomes an adjust drag. hover-capable pens
	// keep drawing (they can adjust while lifted instead)
	if (touchMode === 'paint' || (penDown && !penHover)) {
		if (touchMode === 'paint') touchMode = 'adjust';
		painting = false;
		picking = false;
		lastPaintX = null;
		lastPaintY = null;
	}
}
function endDragMode(mode) {
	if (mode === 'brush') dragBrush = null;
	else if (mode === 'roundness') dragRoundness = null;
	else if (mode === 'color') dragColor = null;
}

window.addEventListener('keydown', (e) => {
	if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
		e.preventDefault();
		exportGIF();
		return;
	}
	if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
		e.preventDefault();
		fileInput.click();
		return;
	}
	if ((e.metaKey || e.ctrlKey) && !e.altKey) {
		if (e.key === '=' || e.key === '+') { e.preventDefault(); stepZoom(1); return; }
		if (e.key === '-' || e.key === '_') { e.preventDefault(); stepZoom(-1); return; }
		if (e.key === '0') { e.preventDefault(); resetZoom(); return; }
	}
	if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
		const lk = e.key.toLowerCase();
		if (e.key === 'ArrowLeft') { e.preventDefault(); tapArrow(-1); return; }
		if (e.key === 'ArrowRight') { e.preventDefault(); tapArrow(1); return; }
		if (e.key === ' ') { e.preventDefault(); playing ? stopPlayback() : startPlayback(); return; }
		if (lk === 'a') { addFrame(); return; }
		if (lk === 'd') { deleteFrame(); return; }
		if (lk === 'o') {
			if (playing) { stopPlayback(); onionskin = true; }
			else onionskin = !onionskin;
			requestDraw();
			return;
		}
	}
	const k = e.key.toLowerCase();
	const wasDown = keys[k];
	keys[k] = true;
	if (!e.metaKey && !e.ctrlKey) {
		if (k === 'z' || k === 'x' || k === 'c' || k === 'r' || k === 'g' || k === 'b') e.preventDefault();
		if (k === 'x') startDragMode('roundness');
		else if (k === 'z') startDragMode('brush');
		else if (!wasDown && (k === 'r' || k === 'g' || k === 'b')) startDragMode('color');
		else if (k === 'c' && !wasDown && (touchMode === 'paint' || touchMode === 'adjust')) {
			touchMode = 'paint';
			painting = false;
			picking = true;
			lastPaintX = null;
			lastPaintY = null;
			touchPainted = true;
			pickAt(curX, curY);
			requestDraw();
		}
	}
});
window.addEventListener('keyup', (e) => {
	const k = e.key.toLowerCase();
	keys[k] = false;
	if (k === 'x') endDragMode('roundness');
	else if (k === 'z') endDragMode('brush');
	else if (k === 'r' || k === 'g' || k === 'b') {
		if (!keys['r'] && !keys['g'] && !keys['b']) endDragMode('color');
		else if (dragColor) {
			// still holding at least one rgb key - re-anchor from current
			// values so the remaining keys don't jump based on released key's history
			dragColor.anchorY = curClientY !== null ? curClientY : dragColor.anchorY;
			dragColor.r0 = r; dragColor.g0 = g; dragColor.b0 = b;
		}
	}
	// releasing c mid-pick-drag -> back to adjusting if a modifier is still
	// held on a hoverless contact, else seamlessly switch to painting
	if (k === 'c' && picking) {
		picking = false;
		const hoverless = touchMode !== null || (penDown && !penHover);
		if (hoverless && (dragBrush || dragRoundness || dragColor)) {
			if (touchMode !== null) touchMode = 'adjust';
			painting = false;
			if (curClientY !== null) anchorDrags(curClientY);
		} else {
			painting = true;
			lastPaintX = curX;
			lastPaintY = curY;
			localPaintAt(curX, curY);
		}
		requestDraw();
	}
});
window.addEventListener('blur', () => {
	for (const k in keys) keys[k] = false;
	dragBrush = null; dragRoundness = null; dragColor = null;
	painting = false;
	picking = false;
	penDown = false;
	lastPaintX = null;
	lastPaintY = null;
});

// wheel gesture lock: once a wheel gesture starts in a given mode,
// subsequent events in the same burst stay in that mode until the wheel
// goes idle or the controlling modifier set changes. this keeps trackpad
// momentum from leaking into pan after a modifier release, while still
// letting the user swap between modes mid-flick without stale state.
let wheelMode = null;
let wheelIdleTimer = null;
let panning = false;

const BRUSH_DRAG_PX_PER_STEP = 25;	// device px per +/- 1 brush px (below the seam)
const BRUSH_LINEAR_MAX = 6;			// brush px below which resize stays linear/fine
const BRUSH_ACCEL = 0.5;
const MAX_BRUSH = 150;
const ROUNDNESS_DRAG_FULL_PX = 200;
const COLOR_DRAG_FULL_PX = 256;
// each drag carries its own anchor so any combination can run at once
let dragBrush = null;		// {anchorY, start}
let dragRoundness = null;	// {anchorY, start}
let dragColor = null;		// {anchorY, r0, g0, b0}
function touchWheelGesture() {
	if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
	wheelIdleTimer = setTimeout(() => {
		wheelMode = null;
		if (panning) {
			// pan ended - resync the logical-pixel cursor from the real
			// client position so the brush snaps onto its final cell.
			panning = false;
			if (curClientX !== null) {
				const p = clientToWorld(curClientX, curClientY);
				curX = p.x;
				curY = p.y;
			}
			requestDraw();
		}
	}, 150);
}
function pickModifierMode(e) {
	if (e.ctrlKey) return 'zoom';
	return null;
}

window.addEventListener('wheel', (e) => {
	e.preventDefault();
	stopInertia();

	// re-pick mode each event from live modifiers so releasing cmd and
	// immediately starting a shift scroll switches over cleanly. if a
	// burst started with a modifier and the modifier is then released
	// mid-flick, suppress rather than leaking into pan.
	const modMode = pickModifierMode(e);
	if (modMode !== null) {
		wheelMode = modMode;
	} else if (wheelMode === null) {
		wheelMode = 'pan';
	} else if (wheelMode !== 'pan') {
		// modifier released mid-burst: drop the remaining momentum
		// instead of letting it leak into pan.
		touchWheelGesture();
		return;
	}
	touchWheelGesture();

	if (wheelMode === 'zoom') {
		// exponential zoom on the float accumulator so small pinches add up
		applyZoom(Math.exp(-e.deltaY * 0.02), e.clientX, e.clientY);
		requestDraw();
		return;
	}

	// pan - smooth fractional camera. during the pan gesture the draw
	// loop anchors the brush to the real client cursor position so it
	// tracks the pointer smoothly; curX/curY get resynced onto the
	// logical-pixel grid when the wheel idle timer fires.
	panning = true;
	camX += e.deltaX / zoom;
	camY += e.deltaY / zoom;
	requestDraw();
}, { passive: false });

window.addEventListener('beforeunload', (e) => {
	if (dirty) { e.preventDefault(); }
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

// block the OS pinch gesture events too (Safari)
window.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('gesturechange', (e) => e.preventDefault());
window.addEventListener('gestureend', (e) => e.preventDefault());
