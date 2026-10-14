const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'image/*';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);
fileInput.addEventListener('change', (e) => {
	const f = e.target.files && e.target.files[0];
	if (f) importFile(f);
	fileInput.value = '';
});

function formatTimestamp(d) {
	const p = (n) => String(n).padStart(2, '0');
	return p(d.getFullYear() % 100) + '\u00b7' + p(d.getMonth() + 1) + '\u00b7' + p(d.getDate()) + '\u00b7' + p(d.getHours()) + '\u00b7' + p(d.getMinutes()) + '\u00b7' + p(d.getSeconds());
}

// union of painted chunk bounds across all frames, so every exported
// frame shares the canvas of the biggest one
function frameBounds() {
	let any = false, minCx = Infinity, minCy = Infinity, maxCx = -Infinity, maxCy = -Infinity;
	for (const f of frames) {
		for (const k of f.keys()) {
			any = true;
			const [cx, cy] = k.split(',').map(Number);
			if (cx < minCx) minCx = cx;
			if (cy < minCy) minCy = cy;
			if (cx > maxCx) maxCx = cx;
			if (cy > maxCy) maxCy = cy;
		}
	}
	return any ? { minCx, minCy, maxCx, maxCy } : null;
}

function renderFrame(f, b, w, h) {
	const out = document.createElement('canvas');
	out.width = w;
	out.height = h;
	const octx = out.getContext('2d');
	octx.fillStyle = '#000';
	octx.fillRect(0, 0, w, h);
	for (const [k, c] of f) {
		const [cx, cy] = k.split(',').map(Number);
		octx.drawImage(c.canvas, (cx - b.minCx) * CHUNK, (cy - b.minCy) * CHUNK);
	}
	return octx.getImageData(0, 0, w, h);
}

function lzwEncode(minCode, data, lookup, out) {
	const clear = 1 << minCode, eoi = clear + 1;
	let codeSize = minCode + 1, next = eoi + 1;
	let dict = new Map();
	let acc = 0, accBits = 0;
	let block = [];
	const flushBlock = () => {
		if (block.length) { out.push(block.length, ...block); block = []; }
	};
	const emit = (code) => {
		acc |= code << accBits;
		accBits += codeSize;
		while (accBits >= 8) {
			block.push(acc & 255);
			acc >>= 8;
			accBits -= 8;
			if (block.length === 255) flushBlock();
		}
	};
	const idx = (i) => lookup((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
	emit(clear);
	let prev = idx(0);
	for (let i = 4; i < data.length; i += 4) {
		const k = idx(i);
		const key = prev * 256 + k;
		if (dict.has(key)) { prev = dict.get(key); continue; }
		emit(prev);
		if (next === 4096) {
			emit(clear);
			dict = new Map();
			next = eoi + 1;
			codeSize = minCode + 1;
		} else {
			if (next >= (1 << codeSize)) codeSize++;
			dict.set(key, next++);
		}
		prev = k;
	}
	emit(prev);
	emit(eoi);
	if (accBits) block.push(acc & 255);
	flushBlock();
}

// splits the colors into up to n boxes, each time cutting the box with the
// widest channel at its weighted median; each box becomes its average color
function medianCut(counts, n) {
	const box = (e) => {
		const lo = [255, 255, 255], hi = [0, 0, 0];
		for (const [c] of e) {
			for (let ch = 0; ch < 3; ch++) {
				const v = (c >> (16 - ch * 8)) & 255;
				if (v < lo[ch]) lo[ch] = v;
				if (v > hi[ch]) hi[ch] = v;
			}
		}
		let ch = 0;
		for (let i = 1; i < 3; i++) if (hi[i] - lo[i] > hi[ch] - lo[ch]) ch = i;
		return { e, sh: 16 - ch * 8, range: e.length > 1 ? hi[ch] - lo[ch] : 0 };
	};
	const boxes = [box([...counts])];
	while (boxes.length < n) {
		let best = -1;
		for (let i = 0; i < boxes.length; i++) {
			if (boxes[i].range > 0 && (best < 0 || boxes[i].range > boxes[best].range)) best = i;
		}
		if (best < 0) break;
		const { e, sh } = boxes[best];
		e.sort((a, b) => ((a[0] >> sh) & 255) - ((b[0] >> sh) & 255));
		let total = 0;
		for (const [, k] of e) total += k;
		let acc = 0, cut = 1;
		for (; cut < e.length - 1; cut++) {
			acc += e[cut - 1][1];
			if (acc >= total / 2) break;
		}
		boxes.splice(best, 1, box(e.slice(0, cut)), box(e.slice(cut)));
	}
	return boxes.map(({ e }) => {
		let r = 0, g = 0, b = 0, t = 0;
		for (const [c, k] of e) {
			r += ((c >> 16) & 255) * k;
			g += ((c >> 8) & 255) * k;
			b += (c & 255) * k;
			t += k;
		}
		return (Math.round(r / t) << 16) | (Math.round(g / t) << 8) | Math.round(b / t);
	});
}

// one frame's color table: its exact colors when there are <=256, else a
// median cut of them with each color mapped to its nearest entry
function framePalette(d) {
	const counts = new Map();
	for (let i = 0; i < d.length; i += 4) {
		const c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
		counts.set(c, (counts.get(c) || 0) + 1);
	}
	if (counts.size <= 256) {
		const pal = [...counts.keys()];
		const idx = new Map(pal.map((c, i) => [c, i]));
		return { pal, lookup: (c) => idx.get(c) };
	}
	const pal = medianCut(counts, 256);
	const cache = new Map();
	const lookup = (c) => {
		let best = cache.get(c);
		if (best !== undefined) return best;
		const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
		let bestD = Infinity;
		for (let i = 0; i < pal.length; i++) {
			const p = pal[i];
			const dr = ((p >> 16) & 255) - r, dg = ((p >> 8) & 255) - g, db = (p & 255) - b;
			const dist = dr * dr + dg * dg + db * db;
			if (dist < bestD) { bestD = dist; best = i; }
		}
		cache.set(c, best);
		return best;
	};
	return { pal, lookup };
}

// minimal GIF89a encoder: each frame carries its own color table, so a
// frame only goes lossy when it alone has more than 256 colors
function encodeGIF(images, w, h, delayMs) {
	const out = [];
	const u16 = (v) => { out.push(v & 255, (v >> 8) & 255); };
	out.push(71, 73, 70, 56, 57, 97); // "GIF89a"
	u16(w); u16(h);
	out.push(0, 0, 0); // no global color table
	const animated = images.length > 1;
	if (animated) {
		// NETSCAPE2.0 loop forever
		out.push(0x21, 0xff, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0);
	}
	const delay = clamp(Math.round(delayMs / 10), 2, 65535);
	for (const img of images) {
		const { pal, lookup } = framePalette(img.data);
		let bits = 2;
		while ((1 << bits) < pal.length) bits++;
		if (animated) out.push(0x21, 0xf9, 4, 0, delay & 255, (delay >> 8) & 255, 0, 0);
		out.push(0x2c);
		u16(0); u16(0); u16(w); u16(h);
		out.push(0x80 | (bits - 1)); // local color table
		for (let i = 0; i < (1 << bits); i++) {
			const c = pal[i] || 0;
			out.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
		}
		const minCode = Math.max(2, bits);
		out.push(minCode);
		lzwEncode(minCode, img.data, lookup, out);
		out.push(0);
	}
	out.push(0x3b);
	return new Uint8Array(out);
}

function exportGIF() {
	const b = frameBounds();
	if (!b) return;
	const w = (b.maxCx - b.minCx + 1) * CHUNK;
	const h = (b.maxCy - b.minCy + 1) * CHUNK;
	const imgs = frames.map((f) => renderFrame(f, b, w, h));
	if (dir === -1) imgs.reverse();
	const blob = new Blob([encodeGIF(imgs, w, h, frameInterval)], { type: 'image/gif' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'animus \u00b7 ' + formatTimestamp(new Date()) + '.gif';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
	dirty = false;
}

function imageToFrame(src, w, h) {
	const ox = -Math.floor(w / 2);
	const oy = -Math.floor(h / 2);
	const f = newFrameMap();
	drawIntoFrame(f, src, w, h, ox, oy);
	return { f, w, h, ox, oy };
}

function drawIntoFrame(f, src, w, h, ox, oy) {
	const cx0 = Math.floor(ox / CHUNK);
	const cy0 = Math.floor(oy / CHUNK);
	const cx1 = Math.floor((ox + w - 1) / CHUNK);
	const cy1 = Math.floor((oy + h - 1) / CHUNK);
	for (let cy = cy0; cy <= cy1; cy++) {
		for (let cx = cx0; cx <= cx1; cx++) {
			getOrCreateChunk(cx, cy, f).ctx.drawImage(src, ox - cx * CHUNK, oy - cy * CHUNK);
		}
	}
}

function finishImport(newFrames, w, h, ox, oy) {
	frames = newFrames;
	dir = 1;
	setFrame(0);
	camX = ox - (cssW / zoom - w) / 2;
	camY = oy - (cssH / zoom - h) / 2;
	dirty = false;
	requestDraw();
}

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

// decoded frames of the file as {src, w, h, close}
async function decodeSources(file) {
	// ImageDecoder gives us every frame of an animated gif; fall back to
	// single-image import where unsupported
	if (typeof ImageDecoder !== 'undefined') {
		try {
			const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
			await dec.tracks.ready;
			const count = dec.tracks.selectedTrack.frameCount;
			const srcs = [];
			let interval = 0;
			for (let i = 0; i < count; i++) {
				const { image } = await dec.decode({ frameIndex: i });
				if (i === 0 && image.duration) interval = Math.max(20, image.duration / 1000);
				srcs.push({ src: image, w: image.displayWidth, h: image.displayHeight, close: () => image.close() });
			}
			return { srcs, interval };
		} catch (err) {}
	}
	const url = URL.createObjectURL(file);
	try {
		const img = await loadImage(url);
		return { srcs: [{ src: img, w: img.width, h: img.height }], interval: 0 };
	} catch (err) {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function applyImport(srcs) {
	const newFrames = [];
	let last = null;
	for (const s of srcs) {
		last = imageToFrame(s.src, s.w, s.h);
		newFrames.push(last.f);
	}
	if (last) finishImport(newFrames, last.w, last.h, last.ox, last.oy);
}

// flat png per frame, positioned in world space, so an import can be handed
// to everyone else in the room (and to whoever joins later)
function sourcesToBases(srcs) {
	const cnv = document.createElement('canvas');
	const cctx = cnv.getContext('2d');
	return srcs.map((s) => {
		cnv.width = s.w;
		cnv.height = s.h;
		cctx.drawImage(s.src, 0, 0);
		return { img: cnv.toDataURL('image/png'), ox: -Math.floor(s.w / 2), oy: -Math.floor(s.h / 2), w: s.w, h: s.h };
	});
}

async function importFile(file) {
	if (dirty && !confirm('Importing will discard the current ' + (frames.length > 1 ? 'animation' : 'painting') + '. Continue?' + (net.on ? ' (for everyone)' : ''))) return;
	if (playing) stopPlayback();
	const dec = await decodeSources(file);
	if (!dec || !dec.srcs.length) return;
	if (dec.interval) frameInterval = dec.interval;
	if (net.on) net.send({ t: 'reset', frames: sourcesToBases(dec.srcs), interval: frameInterval });
	else applyImport(dec.srcs);
	for (const s of dec.srcs) if (s.close) s.close();
}
