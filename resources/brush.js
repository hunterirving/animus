let r = 255, g = 255, b = 255;
let brush = 1;
let roundness = 0;

// keyed cache: the local brush and every peer's brush pull from the same one
const brushShapes = new Map();
const BRUSH_CACHE_MAX = 64;
function getBrushShape() { return brushShapeFor(brush, roundness, r, g, b); }
function brushShapeFor(n, round, sr, sg, sb) {
	const key = n + ',' + round + ',' + sr + ',' + sg + ',' + sb;
	const hit = brushShapes.get(key);
	if (hit) return hit;
	if (brushShapes.size >= BRUSH_CACHE_MAX) brushShapes.clear();
	const inside = new Uint8Array(n * n);
	const rad = round * (n / 2);
	const rad2 = rad * rad;
	const lo = rad - 0.5;
	const hi = n - 0.5 - rad;
	for (let dy = 0; dy < n; dy++) {
		for (let dx = 0; dx < n; dx++) {
			let qx = 0, qy = 0;
			if (dx < lo) qx = lo - dx;
			else if (dx > hi) qx = dx - hi;
			if (dy < lo) qy = lo - dy;
			else if (dy > hi) qy = dy - hi;
			if (qx * qx + qy * qy <= rad2 + 1e-9) inside[dy * n + dx] = 1;
		}
	}
	const sprite = document.createElement('canvas');
	sprite.width = n;
	sprite.height = n;
	const sctx = sprite.getContext('2d');
	const img = sctx.createImageData(n, n);
	const data = img.data;
	for (let i = 0; i < n * n; i++) {
		if (inside[i]) {
			data[i * 4] = sr;
			data[i * 4 + 1] = sg;
			data[i * 4 + 2] = sb;
			data[i * 4 + 3] = 255;
		}
	}
	sctx.putImageData(img, 0, 0);

	const fillRuns = [];
	for (let dy = 0; dy < n; dy++) {
		let dx = 0;
		while (dx < n) {
			if (!inside[dy * n + dx]) { dx++; continue; }
			let dx1 = dx + 1;
			while (dx1 < n && inside[dy * n + dx1]) dx1++;
			fillRuns.push(dx, dy, dx1 - dx);
			dx = dx1;
		}
	}

	// 1-pixel outline ring: cells outside the shape that are 8-way adjacent
	// to any inside cell. stored as row-runs in an (n+2)x(n+2) grid with
	// coordinates offset by -1 so they index directly in shape-local space.
	const m = n + 2;
	const ring = new Uint8Array(m * m);
	const isIn = (x, y) => x >= 0 && y >= 0 && x < n && y < n && inside[y * n + x] === 1;
	for (let y = -1; y <= n; y++) {
		for (let x = -1; x <= n; x++) {
			if (isIn(x, y)) continue;
			let adj = false;
			for (let oy = -1; oy <= 1 && !adj; oy++) {
				for (let ox = -1; ox <= 1 && !adj; ox++) {
					if (ox === 0 && oy === 0) continue;
					if (isIn(x + ox, y + oy)) adj = true;
				}
			}
			if (adj) ring[(y + 1) * m + (x + 1)] = 1;
		}
	}
	const outlineRuns = [];
	for (let y = 0; y < m; y++) {
		let x = 0;
		while (x < m) {
			if (!ring[y * m + x]) { x++; continue; }
			let x1 = x + 1;
			while (x1 < m && ring[y * m + x1]) x1++;
			outlineRuns.push(x - 1, y - 1, x1 - x);
			x = x1;
		}
	}

	const shape = { inside, sprite, fillRuns, outlineRuns, n };
	brushShapes.set(key, shape);
	return shape;
}

// outline blend: 0 = dark color (lighten with screen), 1 = light color (darken with multiply).
let outlineLightness = 1;
let outlineAnimStart = 0;
let outlineAnimFrom = 1;
let outlineAnimTo = 1;
const OUTLINE_ANIM_MS = 250;
function setOutlineTarget(target) {
	if (target === outlineAnimTo) return;
	outlineAnimFrom = outlineLightness;
	outlineAnimTo = target;
	outlineAnimStart = performance.now();
	requestDraw();
}

// displayed cursor fill eases toward r/g/b; painting still uses r/g/b immediately.
let dispR = 255, dispG = 255, dispB = 255;
let colorAnimStart = 0;
let colorAnimFromR = 255, colorAnimFromG = 255, colorAnimFromB = 255;
let colorAnimToR = 255, colorAnimToG = 255, colorAnimToB = 255;
function setDisplayColorTarget(nr, ng, nb) {
	if (nr === colorAnimToR && ng === colorAnimToG && nb === colorAnimToB) return;
	colorAnimFromR = dispR; colorAnimFromG = dispG; colorAnimFromB = dispB;
	colorAnimToR = nr; colorAnimToG = ng; colorAnimToB = nb;
	colorAnimStart = performance.now();
	requestDraw();
}

const faviconEl = document.getElementById('favicon');
function updateFavicon() {
	const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1' fill='rgb(" + r + "," + g + "," + b + ")'/></svg>";
	faviconEl.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function pickAt(cx, cy) {
	const c = readPixel(cx, cy);
	r = c[0]; g = c[1]; b = c[2];
	setOutlineTarget((r + g + b > 384) ? 1 : 0);
	setDisplayColorTarget(r, g, b);
	updateFavicon();
}

function setColor(nr, ng, nb) {
	r = nr; g = ng; b = nb;
	setOutlineTarget((r + g + b > 384) ? 1 : 0);
	updateFavicon();
	dispR = r; dispG = g; dispB = b;
	colorAnimFromR = r; colorAnimFromG = g; colorAnimFromB = b;
	colorAnimToR = r; colorAnimToG = g; colorAnimToB = b;
}
