// painting together: mirrors strokes, frames, and brushes between
// everyone in the room

const net = {
	on: false,
	id: null,
	ws: null,
	peers: new Map(),
	joined: false,	// has this page ever been in a room
	queue: null,	// messages held while a snapshot loads
	lastCursor: '',
	batch: null,	// segments painted this frame, not yet sent
	key: 0,
	pending: [],	// own strokes still waiting for their echo
	overlays: new Map(),	// frame id -> chunk map of those unacked strokes
};

net.send = function (msg) {
	if (!net.on) return;
	try {
		net.ws.send(JSON.stringify(msg));
	} catch (err) {}
};

// a fast pen reports far more moves than anyone can see, so segments pile up
// into one message per animation frame. a new frame, color, or brush starts
// a new batch, since a batch carries a single style
net.paint = function (x0, y0, x1, y1) {
	if (!net.on) return;
	const cur = net.batch;
	if (cur && cur.f === chunks.id && cur.b === brush && cur.s === roundness
		&& cur.c[0] === r && cur.c[1] === g && cur.c[2] === b) {
		cur.o.push(x0, y0, x1, y1);
		return;
	}
	net.flush();
	net.batch = { t: 'p', k: ++net.key, f: chunks.id, o: [x0, y0, x1, y1], c: [r, g, b], b: brush, s: roundness };
	// tracked from the first segment, so the overlay it painted onto is held
	// until the echo commits it to the frame proper
	net.pending.push({ k: net.batch.k, f: chunks.id });
};

net.flush = function () {
	const out = net.batch;
	if (!out) return;
	net.batch = null;
	net.send(out);
};

// an overlay lives exactly as long as some stroke on it awaits its echo
function clearOverlayIfIdle(fid) {
	if (net.pending.some((p) => p.f === fid)) return;
	if (net.overlays.delete(fid)) requestDraw();
}

// called at the end of every draw, so the brush other people see moves
// exactly when ours does, and never more often than a frame
net.sendCursor = function () {
	if (!net.on) return;
	// the target, not the current alpha: everyone else runs the same fade
	// from the moment it starts, so a slow fade-out never reads as a blink
	const v = cursorFadeTo > 0;
	const key = v ? curX + ',' + curY + ',' + brush + ',' + roundness + ',' + r + ',' + g + ',' + b + ',' + chunks.id : '0';
	if (key === net.lastCursor) return;
	net.lastCursor = key;
	net.send({ t: 'c', x: curX, y: curY, b: brush, s: roundness, c: [r, g, b], f: chunks.id, v });
};

function frameSnapshot(f) {
	let any = false, minCx = Infinity, minCy = Infinity, maxCx = -Infinity, maxCy = -Infinity;
	for (const k of f.keys()) {
		any = true;
		const [cx, cy] = k.split(',').map(Number);
		if (cx < minCx) minCx = cx;
		if (cy < minCy) minCy = cy;
		if (cx > maxCx) maxCx = cx;
		if (cy > maxCy) maxCy = cy;
	}
	if (!any) return { id: f.id, img: null };
	const w = (maxCx - minCx + 1) * CHUNK;
	const h = (maxCy - minCy + 1) * CHUNK;
	const cnv = document.createElement('canvas');
	cnv.width = w;
	cnv.height = h;
	const cctx = cnv.getContext('2d');
	cctx.fillStyle = '#000';
	cctx.fillRect(0, 0, w, h);
	for (const [k, c] of f) {
		const [cx, cy] = k.split(',').map(Number);
		cctx.drawImage(c.canvas, (cx - minCx) * CHUNK, (cy - minCy) * CHUNK);
	}
	return { id: f.id, img: cnv.toDataURL('image/png'), ox: minCx * CHUNK, oy: minCy * CHUNK, w, h };
}

// rebuild frames from flat images the server is holding
async function framesFromBases(list) {
	const out = [];
	for (const e of list) {
		const f = newFrameMap(e.id);
		if (e.img) {
			try {
				const img = await loadImage(e.img);
				drawIntoFrame(f, img, e.w || img.width, e.h || img.height, e.ox || 0, e.oy || 0);
			} catch (err) {}
		}
		out.push(f);
	}
	return out;
}

// hold live messages until the frames they refer to exist
function netDefer(msg) {
	if (!net.queue) return false;
	net.queue.push(msg);
	return true;
}

function netFlush() {
	const q = net.queue;
	net.queue = null;
	if (!q) return;
	for (const msg of q) netHandle(msg);
}

// swap in a server-supplied frame list, replaying anything that arrived
// while the images were decoding only after `after` has caught us up
async function netAdopt(list, after) {
	net.queue = [];
	const built = await framesFromBases(list);
	frames = built;
	setFrame(0);
	if (after) after();
	netFlush();
	requestDraw();
}

function netHandle(msg) {
	if (msg.t === 'init') {
		net.id = msg.id;
		net.batch = null;
		net.pending.length = 0;
		net.overlays.clear();
		if (msg.interval) frameInterval = msg.interval;
		netAdopt(msg.frames, () => {
			for (const e of msg.frames) {
				for (const op of e.ops || []) applyPaintOp({ ...op, f: e.id });
			}
			dirty = false;
		});
		return;
	}
	if (netDefer(msg)) return;
	if (msg.t === 'p') {
		// strokes land in the frame strictly in the order the server sent
		// them - ours included. until now our own stroke existed only on the
		// overlay; this echo is what commits it, so every painter's frame is
		// the same ops in the same order
		applyPaintOp(msg);
		if (msg.by === net.id) {
			const i = net.pending.findIndex((p) => p.k === msg.k);
			if (i < 0) return;
			// earlier entries can only be strokes the server dropped (their
			// frame was deleted); sweep them along
			const gone = net.pending.splice(0, i + 1);
			for (const p of gone) clearOverlayIfIdle(p.f);
		}
	} else if (msg.t === 'c') {
		const p = net.peers.get(msg.id) || { alpha: 0, fadeFrom: 0, fadeTo: 0, fadeStart: 0 };
		const target = msg.v ? 1 : 0;
		if (target !== p.fadeTo) {
			p.fadeFrom = p.alpha;
			p.fadeTo = target;
			p.fadeStart = performance.now();
		}
		p.x = msg.x; p.y = msg.y; p.b = msg.b; p.s = msg.s; p.c = msg.c; p.f = msg.f;
		net.peers.set(msg.id, p);
		requestDraw();
	} else if (msg.t === 'bye') {
		const p = net.peers.get(msg.id);
		if (p && p.fadeTo !== 0) {
			p.fadeFrom = p.alpha;
			p.fadeTo = 0;
			p.fadeStart = performance.now();
		}
		requestDraw();
	} else if (msg.t === 'af') {
		applyAddFrame(msg.at, msg.id, msg.by === net.id);
	} else if (msg.t === 'df') {
		// the server drops strokes aimed at a deleted frame, so their echoes
		// never come; the frame is going away, and its overlay with it
		net.pending = net.pending.filter((p) => p.f !== msg.id);
		net.overlays.delete(msg.id);
		applyDeleteFrame(msg.id);
	} else if (msg.t === 'reset') {
		if (playing) stopPlayback();
		net.pending.length = 0;
		net.overlays.clear();
		if (msg.interval) frameInterval = msg.interval;
		netAdopt(msg.frames, () => {
			const first = msg.frames[0] || {};
			dir = 1;
			camX = (first.ox || 0) - (cssW / zoom - (first.w || 0)) / 2;
			camY = (first.oy || 0) - (cssH / zoom - (first.h || 0)) / 2;
			dirty = false;
		});
	} else if (msg.t === 'snap') {
		// the server's stroke log got long - hand it flat images instead so
		// the next person to join doesn't have to replay the whole session
		net.send({ t: 'snapshot', upto: msg.upto, frames: frames.map(frameSnapshot) });
	}
}

function netConnect() {
	if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
	const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
	ws.onopen = () => {
		net.ws = ws;
		net.on = true;
		net.joined = true;
		net.lastCursor = '';
	};
	ws.onmessage = (e) => {
		let msg = null;
		try { msg = JSON.parse(e.data); } catch (err) { return; }
		netHandle(msg);
	};
	ws.onclose = () => {
		const wasOn = net.on;
		net.on = false;
		net.ws = null;
		net.peers.clear();
		net.queue = null;
		// whatever was in flight is moot: the server's state wins on the
		// way back in
		net.batch = null;
		net.pending.length = 0;
		net.overlays.clear();
		if (wasOn) requestDraw();
		// a page that was never in a room (opened from a file, or from a
		// static host) stays solo; one that was keeps reaching for the
		// server, which may just be restarting
		if (net.joined) setTimeout(netConnect, 1500);
	};
	ws.onerror = () => ws.close();
}
