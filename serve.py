#!/usr/bin/env python3
"""serve animus over the local network with a shared canvas.

usage: ./serve.py [port]
"""

import base64
import hashlib
import json
import os
import queue
import socket
import struct
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8000
# per-painter outbound backlog. a stroke burst is a few hundred small messages,
# so this is generous; past it the connection is too far behind to be correct
SEND_QUEUE_MAX = 4096
# rfc 6455 fixes this string
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_PAYLOAD = 64 * 1024 * 1024

# once the stored stroke log for the room passes this, ask a painter for flat
# images of the frames so joiners don't have to replay an entire session
SNAPSHOT_AFTER_OPS = 4000
SNAPSHOT_COOLDOWN = 15.0

# the ways a connection ends when the other side simply walks off
DEAD_SOCKET = (ConnectionError, BrokenPipeError, TimeoutError, socket.timeout)


def read_exact(rfile, n):
	buf = b''
	while len(buf) < n:
		chunk = rfile.read(n - len(buf))
		if not chunk:
			return None
		buf += chunk
	return buf


def unmask(payload, mask):
	if not payload:
		return payload
	n = len(payload)
	# xor the whole payload as one big int: the repeated key is trimmed back
	# down to n bytes so byte i lines up with mask[i % 4]
	rep = mask * (n // 4 + 1)
	key = int.from_bytes(rep, 'big') >> (8 * (len(rep) - n))
	return (int.from_bytes(payload, 'big') ^ key).to_bytes(n, 'big')


def ws_recv(rfile, on_control=None):
	"""next complete data message as (opcode, payload), or None when the peer
	closes. control frames are answered inline so they can't interrupt a
	message that arrives in fragments."""
	data = b''
	msg_op = None
	while True:
		hdr = read_exact(rfile, 2)
		if hdr is None:
			return None
		fin = hdr[0] & 0x80
		op = hdr[0] & 0x0f
		masked = hdr[1] & 0x80
		length = hdr[1] & 0x7f
		if length == 126:
			ext = read_exact(rfile, 2)
			if ext is None:
				return None
			length = struct.unpack('>H', ext)[0]
		elif length == 127:
			ext = read_exact(rfile, 8)
			if ext is None:
				return None
			length = struct.unpack('>Q', ext)[0]
		if length > MAX_PAYLOAD:
			return None
		mask = read_exact(rfile, 4) if masked else b''
		if masked and mask is None:
			return None
		payload = read_exact(rfile, length) if length else b''
		if payload is None:
			return None
		if masked:
			payload = unmask(payload, mask)
		if op & 0x8:
			if op == 0x8:
				return None
			if op == 0x9 and on_control:
				on_control(0xa, payload)
			continue
		if op != 0:
			msg_op = op
			data = payload
		else:
			data += payload
		if fin:
			return msg_op or 1, data


def ws_frame(payload, opcode=1):
	head = bytearray([0x80 | opcode])
	n = len(payload)
	if n < 126:
		head.append(n)
	elif n < 65536:
		head.append(126)
		head += struct.pack('>H', n)
	else:
		head.append(127)
		head += struct.pack('>Q', n)
	return bytes(head) + payload


class Conn:
	"""one painter. writes go through a queue and a dedicated thread so a
	painter on bad wifi can never stall the room: their backlog is theirs."""

	_seq = 0
	_seq_lock = threading.Lock()

	def __init__(self, sock):
		self.sock = sock
		self.alive = True
		self.joined = time.time()
		self.q = queue.Queue(maxsize=SEND_QUEUE_MAX)
		with Conn._seq_lock:
			Conn._seq += 1
			self.id = 'c%d' % Conn._seq
		self.writer = threading.Thread(target=self._pump, daemon=True)
		self.writer.start()

	def _pump(self):
		while True:
			item = self.q.get()
			if item is None:
				return
			payload, opcode = item
			try:
				self.sock.sendall(ws_frame(payload, opcode))
			except OSError:
				self.kill()
				return

	def kill(self):
		"""drop the connection; the page reconnects and re-syncs from scratch"""
		if not self.alive:
			return
		self.alive = False
		try:
			self.sock.shutdown(socket.SHUT_RDWR)
		except OSError:
			pass
		try:
			self.q.put_nowait(None)
		except queue.Full:
			pass

	def raw(self, payload, opcode=1, droppable=False):
		if not self.alive:
			return
		try:
			self.q.put_nowait((payload, opcode))
		except queue.Full:
			# a stale brush position is worth nothing, so let it go. a lost
			# stroke would desync this painter for good, so cut them loose
			# instead and let the reconnect hand them the room again
			if not droppable:
				self.kill()

	def send(self, obj, droppable=False):
		self.raw(json.dumps(obj, separators=(',', ':')).encode('utf-8'), droppable=droppable)


class Room:
	def __init__(self):
		self.lock = threading.RLock()
		self.clients = []
		self.frame_seq = 0
		self.op_seq = 0
		self.op_count = 0	# stored strokes, tracked rather than recounted
		self.frames = [self.blank_frame()]
		self.index = {f['id']: f for f in self.frames}
		self.interval = 250
		self.snap_pending = False
		self.snap_at = 0.0

	def blank_frame(self):
		self.frame_seq += 1
		return {'id': 'f%d' % self.frame_seq, 'img': None, 'ox': 0, 'oy': 0, 'w': 0, 'h': 0, 'ops': []}

	def base_frame(self, src):
		f = self.blank_frame()
		if isinstance(src, dict) and src.get('img'):
			f['img'] = src['img']
			f['ox'] = int(src.get('ox', 0))
			f['oy'] = int(src.get('oy', 0))
			f['w'] = int(src.get('w', 0))
			f['h'] = int(src.get('h', 0))
		return f

	def frame(self, fid):
		return self.index.get(fid)

	def wire_frames(self, with_ops=True):
		out = []
		for f in self.frames:
			e = {'id': f['id'], 'img': f['img'], 'ox': f['ox'], 'oy': f['oy'], 'w': f['w'], 'h': f['h']}
			if with_ops:
				e['ops'] = f['ops']
			out.append(e)
		return out

	def broadcast(self, msg, skip=None, droppable=False):
		payload = json.dumps(msg, separators=(',', ':')).encode('utf-8')
		with self.lock:
			targets = [c for c in self.clients if c is not skip]
		for c in targets:
			c.raw(payload, droppable=droppable)

	def join(self, conn):
		with self.lock:
			self.clients.append(conn)
			conn.send({
				't': 'init',
				'id': conn.id,
				'frames': self.wire_frames(),
				'interval': self.interval,
			})
			print('  + %s joined (%d painting)' % (conn.id, len(self.clients)))

	def leave(self, conn):
		with self.lock:
			if conn in self.clients:
				self.clients.remove(conn)
			# the painter we asked for a flat copy may be the one leaving; let
			# the next stroke ask someone else
			self.snap_pending = False
			print('  - %s left   (%d painting)' % (conn.id, len(self.clients)))
		self.broadcast({'t': 'bye', 'id': conn.id})

	def maybe_snapshot(self):
		"""ask one painter to flatten the room so the stroke log stays bounded"""
		now = time.time()
		if self.snap_pending or now - self.snap_at < SNAPSHOT_COOLDOWN:
			return
		if self.op_count < SNAPSHOT_AFTER_OPS or not self.clients:
			return
		self.snap_pending = True
		self.snap_at = now
		self.clients[0].send({'t': 'snap', 'upto': self.op_seq})

	def set_frames(self, frames):
		self.frames = frames
		self.index = {f['id']: f for f in frames}
		self.op_count = sum(len(f['ops']) for f in frames)

	def handle(self, conn, msg):
		t = msg.get('t')
		if t == 'p':
			with self.lock:
				f = self.frame(msg.get('f'))
				if f is None:
					return
				self.op_seq += 1
				op = {
					'n': self.op_seq,
					'o': msg.get('o'),
					'c': msg.get('c'),
					'b': msg.get('b'),
					's': msg.get('s'),
				}
				f['ops'].append(op)
				self.op_count += 1
				self.maybe_snapshot()
				out = dict(op)
				out['t'] = 'p'
				out['f'] = f['id']
				out['by'] = conn.id
				# the painter's own tag for this batch, so they can recognise it
				# coming back; not stored, it means nothing to anyone else
				if msg.get('k') is not None:
					out['k'] = msg['k']
				# broadcast under the lock so wire order matches sequence order;
				# sends only enqueue, so nothing slow happens in here. echoed to
				# the painter too: the ack is what commits their stroke
				self.broadcast(out)
		elif t == 'c':
			msg['id'] = conn.id
			self.broadcast(msg, skip=conn, droppable=True)
		elif t == 'af':
			with self.lock:
				at = max(0, min(int(msg.get('at', len(self.frames))), len(self.frames)))
				f = self.blank_frame()
				self.frames.insert(at, f)
				self.index[f['id']] = f
				self.broadcast({'t': 'af', 'at': at, 'id': f['id'], 'by': conn.id})
		elif t == 'df':
			with self.lock:
				if len(self.frames) <= 1:
					return
				f = self.frame(msg.get('id'))
				if f is None:
					return
				self.frames.remove(f)
				del self.index[f['id']]
				self.op_count -= len(f['ops'])
				self.broadcast({'t': 'df', 'id': f['id'], 'by': conn.id})
		elif t == 'reset':
			srcs = msg.get('frames') or []
			if not srcs:
				return
			with self.lock:
				self.set_frames([self.base_frame(s) for s in srcs])
				self.interval = int(msg.get('interval') or self.interval)
				self.snap_pending = False
				self.broadcast({
					't': 'reset',
					'frames': self.wire_frames(with_ops=False),
					'interval': self.interval,
					'by': conn.id,
				})
		elif t == 'snapshot':
			upto = int(msg.get('upto') or 0)
			with self.lock:
				self.snap_pending = False
				for src in msg.get('frames') or []:
					f = self.frame(src.get('id'))
					if f is None:
						continue
					f['img'] = src.get('img')
					f['ox'] = int(src.get('ox', 0))
					f['oy'] = int(src.get('oy', 0))
					f['w'] = int(src.get('w', 0))
					f['h'] = int(src.get('h', 0))
				# strokes newer than the snapshot are kept; a stroke that made it
				# into the image and also survives here just paints itself twice
				kept = 0
				for f in self.frames:
					f['ops'] = [o for o in f['ops'] if o['n'] > upto]
					kept += len(f['ops'])
				self.op_count = kept
		elif t == 'interval':
			with self.lock:
				self.interval = int(msg.get('v') or self.interval)


room = Room()


class Server(ThreadingHTTPServer):
	daemon_threads = True
	# a whole request thread can still unwind on a dropped socket, outside any
	# handler we control. same story, same silence
	def handle_error(self, request, client_address):
		if isinstance(sys.exc_info()[1], DEAD_SOCKET):
			return
		super().handle_error(request, client_address)


class Handler(SimpleHTTPRequestHandler):
	protocol_version = 'HTTP/1.1'
	server_version = 'animus'
	# tiny realtime frames must go out now, not sit in nagle's buffer waiting
	# on a watcher's delayed acks
	disable_nagle_algorithm = True

	def __init__(self, *a, **kw):
		super().__init__(*a, directory=ROOT, **kw)

	def log_message(self, fmt, *args):
		pass

	def handle(self):
		try:
			super().handle()
		except DEAD_SOCKET:
			self.close_connection = True

	def finish(self):
		try:
			super().finish()
		except DEAD_SOCKET:
			pass

	def end_headers(self):
		self.send_header('Cache-Control', 'no-store')
		super().end_headers()

	def do_GET(self):
		if self.path.split('?')[0] == '/ws':
			self.do_ws()
			return
		super().do_GET()

	def do_ws(self):
		key = self.headers.get('Sec-WebSocket-Key')
		if not key or 'websocket' not in (self.headers.get('Upgrade') or '').lower():
			self.send_error(400, 'expected a websocket upgrade')
			return
		accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
		self.close_connection = True
		self.send_response(101, 'Switching Protocols')
		self.send_header('Upgrade', 'websocket')
		self.send_header('Connection', 'Upgrade')
		self.send_header('Sec-WebSocket-Accept', accept)
		self.end_headers()
		self.wfile.flush()

		conn = Conn(self.connection)
		room.join(conn)
		try:
			pong = lambda code, data: conn.raw(data, code)
			while conn.alive:
				msg = ws_recv(self.rfile, pong)
				if msg is None:
					break
				op, payload = msg
				if op != 0x1:
					continue
				try:
					data = json.loads(payload.decode('utf-8'))
				except (ValueError, UnicodeDecodeError):
					continue
				if isinstance(data, dict):
					room.handle(conn, data)
		except OSError:
			pass
		finally:
			conn.kill()
			room.leave(conn)


def lan_ip():
	s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
	try:
		s.connect(('10.255.255.255', 1))
		return s.getsockname()[0]
	except OSError:
		return '127.0.0.1'
	finally:
		s.close()


def main():
	port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
	for attempt in range(20):
		try:
			httpd = Server(('0.0.0.0', port + attempt), Handler)
			break
		except OSError:
			continue
	else:
		print('no free port near %d' % port)
		return 1
	port = httpd.server_address[1]

	print('\nPress Ctrl+C to stop the server.\n')
	print('http://%s:%d\n' % (lan_ip(), port))


	try:
		httpd.serve_forever()
	except KeyboardInterrupt:
		print('\n\nShutting down server...')
	return 0


if __name__ == '__main__':
	sys.stdout.reconfigure(line_buffering=True)
	sys.exit(main())
