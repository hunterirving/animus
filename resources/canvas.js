const view = document.getElementById('view');
const vctx = view.getContext('2d', { alpha: false });

const CHUNK = 256;
let frameSeq = 0;
// frames carry a stable id so collaborators can name the same frame even
// as the list shifts under inserts and deletes
function newFrameMap(id) {
	const m = new Map();
	m.id = id || ('l' + (++frameSeq));
	return m;
}
let frames = [newFrameMap()];
let frameIdx = 0;
let chunks = frames[0];
let dir = 1; // playback direction: 1 forward, -1 reverse
let onionskin = false;
// how anything belonging to another frame reads: onionskinned content and
// the brushes of painters standing on it
const GHOST_ALPHA = 0.35;
let playing = false;
let playTimer = null;
let frameInterval = 250;
let lastTap = 0;

function chunkKey(cx, cy) { return cx + ',' + cy; }

// remote strokes redirect every paint write into the frame they belong to
let paintMap = null;

function getOrCreateChunk(cx, cy, map) {
	map = map || paintMap || chunks;
	const k = chunkKey(cx, cy);
	let c = map.get(k);
	if (c) return c;
	const cnv = document.createElement('canvas');
	cnv.width = CHUNK;
	cnv.height = CHUNK;
	// overlay chunks stay transparent so they composite over the frame
	const cctx = cnv.getContext('2d', { alpha: !!map.overlay });
	if (!map.overlay) {
		cctx.fillStyle = '#000';
		cctx.fillRect(0, 0, CHUNK, CHUNK);
	}
	c = { canvas: cnv, ctx: cctx };
	map.set(k, c);
	return c;
}

// unacked local strokes paint here, on top of the frame, until their echo
// commits them into it in the room's order
function overlayFor(fid) {
	let m = net.overlays.get(fid);
	if (!m) {
		m = new Map();
		m.id = fid;
		m.overlay = true;
		net.overlays.set(fid, m);
	}
	return m;
}

function paintRect(wx, wy, w, h, color) {
	const x0 = wx, y0 = wy, x1 = wx + w, y1 = wy + h;
	const cx0 = Math.floor(x0 / CHUNK);
	const cy0 = Math.floor(y0 / CHUNK);
	const cx1 = Math.floor((x1 - 1) / CHUNK);
	const cy1 = Math.floor((y1 - 1) / CHUNK);
	for (let cy = cy0; cy <= cy1; cy++) {
		for (let cx = cx0; cx <= cx1; cx++) {
			const c = getOrCreateChunk(cx, cy);
			const lx = Math.max(x0, cx * CHUNK) - cx * CHUNK;
			const ly = Math.max(y0, cy * CHUNK) - cy * CHUNK;
			const rx = Math.min(x1, (cx + 1) * CHUNK) - cx * CHUNK;
			const ry = Math.min(y1, (cy + 1) * CHUNK) - cy * CHUNK;
			c.ctx.fillStyle = color;
			c.ctx.fillRect(lx, ly, rx - lx, ry - ly);
		}
	}
}

function readPixel(wx, wy) {
	const cx = Math.floor(wx / CHUNK);
	const cy = Math.floor(wy / CHUNK);
	const k = chunkKey(cx, cy);
	const lx = wx - cx * CHUNK;
	const ly = wy - cy * CHUNK;
	// an unacked stroke sits on the overlay; pick what's actually on screen
	const ov = net.overlays.get(chunks.id);
	const oc = ov && ov.get(k);
	if (oc) {
		const d = oc.ctx.getImageData(lx, ly, 1, 1).data;
		if (d[3] === 255) return [d[0], d[1], d[2]];
	}
	const c = chunks.get(k);
	if (!c) return [0, 0, 0];
	const d = c.ctx.getImageData(lx, ly, 1, 1).data;
	return [d[0], d[1], d[2]];
}

function setFrame(i) {
	frameIdx = ((i % frames.length) + frames.length) % frames.length;
	chunks = frames[frameIdx];
	// a held pick tracks the frame under it as frames change
	if (picking) pickAt(curX, curY);
	requestDraw();
}

// frame structure changes round-trip through the server when connected, so
// every painter ends up with the same list in the same order
function addFrame() {
	const at = dir === 1 ? frameIdx + 1 : frameIdx;
	if (net.on) { net.send({ t: 'af', at }); return; }
	applyAddFrame(at, null, true);
}

function applyAddFrame(at, id, mine) {
	at = clamp(at, 0, frames.length);
	const cur = chunks;
	frames.splice(at, 0, newFrameMap(id));
	setFrame(mine ? at : frames.indexOf(cur));
}

function deleteFrame() {
	if (frames.length === 1) return;
	if (net.on) { net.send({ t: 'df', id: chunks.id }); return; }
	applyDeleteFrame(chunks.id);
}

function applyDeleteFrame(id) {
	if (frames.length === 1) return;
	const i = frames.findIndex((f) => f.id === id);
	if (i < 0) return;
	const cur = chunks;
	frames.splice(i, 1);
	if (playing && frames.length === 1) stopPlayback();
	const j = frames.indexOf(cur);
	setFrame(j >= 0 ? j : Math.min(i, frames.length - 1));
}

function stopPlayback() {
	playing = false;
	clearTimeout(playTimer);
	requestDraw();
}

function startPlayback() {
	if (frames.length === 1) return;
	playing = true;
	playTimer = setTimeout(function step() {
		setFrame(frameIdx + dir);
		playTimer = setTimeout(step, frameInterval);
	}, frameInterval);
}

function tapArrow(d) {
	dir = d;
	const now = performance.now();
	if (lastTap && now - lastTap <= 10000) {
		frameInterval = now - lastTap;
		// stored, not applied to anyone live: whoever joins next inherits it
		net.send({ t: 'interval', v: Math.round(frameInterval) });
	}
	lastTap = now;
	if (playing) { stopPlayback(); return; }
	setFrame(frameIdx + d);
}

const keys = {};
let painting = false;
let picking = false;
let lastPaintX = null, lastPaintY = null;
let dirty = false;

function brushTopLeft(cx, cy) {
	const off = Math.floor(brush / 2);
	return { x: cx - off, y: cy - off };
}

function paintAt(cx, cy) {
	dirty = true;
	const tl = brushTopLeft(cx, cy);
	if (roundness === 0) {
		paintRect(tl.x, tl.y, brush, brush, 'rgb(' + r + ',' + g + ',' + b + ')');
		return;
	}
	const sprite = getBrushShape().sprite;
	const cx0 = Math.floor(tl.x / CHUNK);
	const cy0 = Math.floor(tl.y / CHUNK);
	const cx1 = Math.floor((tl.x + brush - 1) / CHUNK);
	const cy1 = Math.floor((tl.y + brush - 1) / CHUNK);
	for (let ccy = cy0; ccy <= cy1; ccy++) {
		for (let ccx = cx0; ccx <= cx1; ccx++) {
			const c = getOrCreateChunk(ccx, ccy);
			c.ctx.drawImage(sprite, tl.x - ccx * CHUNK, tl.y - ccy * CHUNK);
		}
	}
}

// every mark the local user makes goes out as a segment; a dot
// is just a zero-length one. in a room the pixels land on the frame's
// overlay - the frame itself only takes strokes in the server's order
function localPaintAt(x, y) {
	if (net.on) paintMap = overlayFor(chunks.id);
	try {
		paintAt(x, y);
	} finally {
		paintMap = null;
	}
	net.paint(x, y, x, y);
}

function localPaintLine(x0, y0, x1, y1) {
	if (net.on) paintMap = overlayFor(chunks.id);
	try {
		paintLine(x0, y0, x1, y1);
	} finally {
		paintMap = null;
	}
	net.paint(x0, y0, x1, y1);
}

// replay someone else's segment into whichever frame it belongs to, with
// their brush, without disturbing the local one
function applyPaintOp(op) {
	const f = frames.find((fr) => fr.id === op.f);
	if (!f || !op.o || !op.c) return;
	const pm = paintMap, pr = r, pg = g, pb = b, pbrush = brush, pround = roundness;
	paintMap = f;
	r = op.c[0]; g = op.c[1]; b = op.c[2];
	brush = op.b; roundness = op.s;
	try {
		for (let i = 0; i + 3 < op.o.length; i += 4) {
			paintLine(op.o[i], op.o[i + 1], op.o[i + 2], op.o[i + 3]);
		}
	} finally {
		paintMap = pm;
		r = pr; g = pg; b = pb;
		brush = pbrush; roundness = pround;
	}
	if (f === chunks) requestDraw();
}

function paintLine(x0, y0, x1, y1) {
	let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
	let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
	let err = dx + dy;
	let x = x0, y = y0;
	while (true) {
		paintAt(x, y);
		if (x === x1 && y === y1) break;
		const e2 = 2 * err;
		if (e2 >= dy) { err += dy; x += sx; }
		if (e2 <= dx) { err += dx; y += sy; }
	}
}
