let drawQueued = false;
function requestDraw() {
	if (drawQueued) return;
	drawQueued = true;
	requestAnimationFrame(() => {
		drawQueued = false;
		draw();
	});
}

function draw() {
	const now = performance.now();
	if (outlineLightness !== outlineAnimTo) {
		const t = (now - outlineAnimStart) / OUTLINE_ANIM_MS;
		if (t >= 1) {
			outlineLightness = outlineAnimTo;
		} else {
			const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			outlineLightness = outlineAnimFrom + (outlineAnimTo - outlineAnimFrom) * e;
			requestDraw();
		}
	}
	if (dispR !== colorAnimToR || dispG !== colorAnimToG || dispB !== colorAnimToB) {
		const t = (now - colorAnimStart) / OUTLINE_ANIM_MS;
		if (t >= 1) {
			dispR = colorAnimToR; dispG = colorAnimToG; dispB = colorAnimToB;
		} else {
			const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			dispR = Math.round(colorAnimFromR + (colorAnimToR - colorAnimFromR) * e);
			dispG = Math.round(colorAnimFromG + (colorAnimToG - colorAnimFromG) * e);
			dispB = Math.round(colorAnimFromB + (colorAnimToB - colorAnimFromB) * e);
			requestDraw();
		}
	}

	const W = view.width, H = view.height;
	vctx.setTransform(1, 0, 0, 1, 0, 0);
	vctx.imageSmoothingEnabled = false;
	vctx.fillStyle = '#000';
	vctx.fillRect(0, 0, W, H);

	// one logical pixel on screen = integer device px. we round here so
	// every logical pixel occupies the exact same number of device pixels:
	// otherwise fractional dpr (1.25/1.5/1.75) makes nearest-neighbor
	// resampling drop or duplicate rows, producing transparent stripes
	// through painted content at high zoom.
	const pxD = Math.max(1, Math.round(zoom * dpr));

	const viewWLog = cssW / zoom;
	const viewHLog = cssH / zoom;
	const wx0 = camX;
	const wy0 = camY;
	const wx1 = camX + viewWLog;
	const wy1 = camY + viewHLog;

	const cx0 = Math.floor(wx0 / CHUNK);
	const cy0 = Math.floor(wy0 / CHUNK);
	const cx1 = Math.floor((wx1 - 1e-9) / CHUNK);
	const cy1 = Math.floor((wy1 - 1e-9) / CHUNK);

	// round destinations to integer device pixels to avoid seams between
	// adjacent chunks. compute right/bottom edges from the neighbor's
	// rounded left/top so shared edges line up exactly.
	const destX = (wx) => Math.round((wx - camX) * pxD);
	const destY = (wy) => Math.round((wy - camY) * pxD);

	for (let cy = cy0; cy <= cy1; cy++) {
		for (let cx = cx0; cx <= cx1; cx++) {
			const c = chunks.get(chunkKey(cx, cy));
			if (!c) continue;
			const x0 = destX(cx * CHUNK);
			const y0 = destY(cy * CHUNK);
			const x1 = destX((cx + 1) * CHUNK);
			const y1 = destY((cy + 1) * CHUNK);
			vctx.drawImage(c.canvas, x0, y0, x1 - x0, y1 - y0);
		}
	}

	// our own strokes still waiting for their echo, composited over the frame
	const overlay = net.overlays.get(chunks.id);
	if (overlay) {
		for (let cy = cy0; cy <= cy1; cy++) {
			for (let cx = cx0; cx <= cx1; cx++) {
				const c = overlay.get(chunkKey(cx, cy));
				if (!c) continue;
				const x0 = destX(cx * CHUNK);
				const y0 = destY(cy * CHUNK);
				vctx.drawImage(c.canvas, x0, y0, destX((cx + 1) * CHUNK) - x0, destY((cy + 1) * CHUNK) - y0);
			}
		}
	}

	// onionskin: ghost the frame behind us in playback order, screen-blended
	// so black contributes nothing over the opaque chunks
	if (onionskin && !playing && frames.length > 1) {
		const ghost = frames[(frameIdx - dir + frames.length) % frames.length];
		const ghostOverlay = net.overlays.get(ghost.id);
		vctx.save();
		vctx.globalAlpha = GHOST_ALPHA;
		vctx.globalCompositeOperation = 'screen';
		for (const layer of ghostOverlay ? [ghost, ghostOverlay] : [ghost]) {
			for (let cy = cy0; cy <= cy1; cy++) {
				for (let cx = cx0; cx <= cx1; cx++) {
					const c = layer.get(chunkKey(cx, cy));
					if (!c) continue;
					const x0 = destX(cx * CHUNK);
					const y0 = destY(cy * CHUNK);
					vctx.drawImage(c.canvas, x0, y0, destX((cx + 1) * CHUNK) - x0, destY((cy + 1) * CHUNK) - y0);
				}
			}
		}
		vctx.restore();
	}

	if (cursorAlpha !== cursorFadeTo) {
		const dur = cursorFadeTo > cursorFadeFrom ? CURSOR_FADE_IN_MS : CURSOR_FADE_OUT_MS;
		const t = (now - cursorFadeStart) / dur;
		if (t >= 1) {
			cursorAlpha = cursorFadeTo;
			if (cursorFadeTo === 0) mouseInside = false;
		} else {
			const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
			cursorAlpha = cursorFadeFrom + (cursorFadeTo - cursorFadeFrom) * e;
			requestDraw();
		}
	}
	// peers first, so the local brush always sits on top of theirs. their
	// fades run here rather than arriving over the wire, so a brush leaving
	// a phone still eases out on everyone else's screen
	for (const [id, p] of net.peers) {
		if (p.alpha !== p.fadeTo) {
			const dur = p.fadeTo > p.fadeFrom ? CURSOR_FADE_IN_MS : CURSOR_FADE_OUT_MS;
			const t = (now - p.fadeStart) / dur;
			if (t >= 1) {
				p.alpha = p.fadeTo;
			} else {
				const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
				p.alpha = p.fadeFrom + (p.fadeTo - p.fadeFrom) * e;
				requestDraw();
			}
		}
		if (p.alpha <= 0) {
			if (p.fadeTo === 0) net.peers.delete(id);
			continue;
		}
		if (!p.b) continue;
		const off = Math.floor(p.b / 2);
		const sx = Math.round((p.x - off - camX) * pxD);
		const sy = Math.round((p.y - off - camY) * pxD);
		if (sx > W || sy > H || sx + p.b * pxD < 0 || sy + p.b * pxD < 0) continue;
		// someone standing on another frame is drawn the way that frame's
		// own marks would be: ghosted, so their brush can't read as
		// something on the frame you're actually painting
		const ghost = p.f !== chunks.id;
		const a = p.alpha * (ghost ? GHOST_ALPHA : 1);
		drawCursorShape(sx, sy, p.b, p.s, p.c, p.c[0] + p.c[1] + p.c[2] > 384 ? 1 : 0, a, pxD, ghost);
	}

	if (mouseInside) {
		const tl = brushTopLeft(curX, curY);
		// round to integer device pixels - camX/camY are fractional (smooth
		// pan), and fractional fillRect coordinates antialias their edges,
		// which would leave transparent lines between adjacent row strips.
		// during an active pan, anchor the cursor to the real client
		// position (rounded only to device pixels) so it tracks smoothly
		// instead of jittering as the logical-pixel floor flips back and
		// forth under a fractional camera. when the pan ends the cursor
		// snaps back to the logical-pixel grid via the idle timer below.
		let sx, sy;
		if (panning && curClientX !== null) {
			const off = Math.floor(brush / 2);
			sx = Math.round((curClientX - off * zoom) * dpr);
			sy = Math.round((curClientY - off * zoom) * dpr);
		} else {
			sx = Math.round((tl.x - camX) * pxD);
			sy = Math.round((tl.y - camY) * pxD);
		}
		drawCursorShape(sx, sy, brush, roundness, [dispR, dispG, dispB], outlineLightness, cursorAlpha, pxD);
	}

	net.flush();
	net.sendCursor();
}

// a brush preview: solid fill in its own color, wrapped in a
// 1-logical-pixel outline cross-faded between darken and lighten. as a
// ghost it drops the outline and screens like onionskinned content, since
// that is exactly what it is - a brush on some other frame
function drawCursorShape(sx, sy, n, round, col, lightness, alpha, pxD, ghost) {
	if (alpha <= 0) return;
	const shape = round === 0 ? null : brushShapeFor(n, round, col[0], col[1], col[2]);
	vctx.save();
	vctx.globalAlpha = alpha;
	if (ghost) vctx.globalCompositeOperation = 'screen';
	vctx.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')';
	if (!shape) {
		vctx.fillRect(sx, sy, n * pxD, n * pxD);
	} else {
		const runs = shape.fillRuns;
		for (let i = 0; i < runs.length; i += 3) {
			vctx.fillRect(sx + runs[i] * pxD, sy + runs[i + 1] * pxD, runs[i + 2] * pxD, pxD);
		}
	}
	if (ghost) {
		vctx.restore();
		return;
	}

	const drawOutline = () => {
		if (shape) {
			const runs = shape.outlineRuns;
			for (let i = 0; i < runs.length; i += 3) {
				vctx.fillRect(sx + runs[i] * pxD, sy + runs[i + 1] * pxD, runs[i + 2] * pxD, pxD);
			}
		} else {
			vctx.fillRect(sx - pxD, sy - pxD, (n + 2) * pxD, pxD); // top
			vctx.fillRect(sx - pxD, sy + n * pxD, (n + 2) * pxD, pxD); // bottom
			vctx.fillRect(sx - pxD, sy, pxD, n * pxD); // left
			vctx.fillRect(sx + n * pxD, sy, pxD, n * pxD); // right
		}
	};
	vctx.save();
	if (lightness > 0) {
		vctx.globalCompositeOperation = 'multiply';
		vctx.globalAlpha = lightness * alpha;
		vctx.fillStyle = 'rgb(128,128,128)';
		drawOutline();
	}
	if (lightness < 1) {
		vctx.globalCompositeOperation = 'screen';
		vctx.globalAlpha = (1 - lightness) * alpha;
		vctx.fillStyle = 'rgb(128,128,128)';
		drawOutline();
	}
	vctx.restore();
	vctx.restore();
}
