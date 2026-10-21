// Dummies & Dragons server
// 1) Serves the game page.
// 2) Relays live state between the TV (host) and phones over WebSockets, grouped by room code.
// 3) Calls the Anthropic API for the AI dungeon master, so the API key never reaches a browser.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MOCK = process.env.MOCK_DM === '1' || (!API_KEY && process.env.NODE_ENV !== 'production');
const MODEL_SMART = process.env.DM_MODEL || 'claude-sonnet-5-5';
const MODEL_FAST = process.env.DM_MODEL_FAST || 'claude-haiku-5-5';
const HOST_PASSWORD = process.env.HOST_PASSWORD || '';       // optional: required to open a table
const MAX_AI_CALLS_PER_ROOM = +process.env.MAX_AI_CALLS_PER_ROOM || 120;
const MAX_ROOMS_PER_IP_PER_DAY = +process.env.MAX_ROOMS_PER_IP_PER_DAY || 20;
const MAX_PEERS = 12;          // TV + 6 players + spectators / extra tabs
const MAX_MSG = 64 * 1024;

/* ---------------- static files ---------------- */
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || /^\/[A-Za-z]{4}$/.test(p)) p = '/index.html'; // /ABCD deep links to a room
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------------- rooms ---------------- */
// room = { code, hostKey, peers: Map<ws, {peer, presence, updatedAt}>, aiCalls, created, lastActive, timer }
const rooms = new Map();
const ipRooms = new Map(); // ip -> [timestamps]
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const validCode = c => typeof c === 'string' && /^[A-Z]{4}$/.test(c);

function getRoom(code) { return rooms.get(code); }
function broadcastPeers(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    const list = [...room.peers.values()].map(p => ({ peer: p.peer, presence: p.presence, updatedAt: p.updatedAt }));
    for (const [ws, me] of room.peers) {
      if (ws.readyState !== 1) continue;
      ws.send(JSON.stringify({ t: 'peers', me: me.peer, peers: list.map(p => ({ ...p, isMe: p.peer === me.peer })) }));
    }
  }, 40);
}
function leave(ws) {
  const room = ws._room; if (!room) return;
  room.peers.delete(ws); ws._room = null; room.lastActive = Date.now();
  broadcastPeers(room);
}
// sweep idle rooms every 10 minutes (rooms live 6h after last activity)
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (!r.peers.size && now - r.lastActive > 6 * 3600e3) rooms.delete(code);
  for (const [ip, ts] of ipRooms) { const keep = ts.filter(t => now - t < 24 * 3600e3); keep.length ? ipRooms.set(ip, keep) : ipRooms.delete(ip); }
}, 10 * 60e3).unref();

/* ---------------- HTTP API ---------------- */
function readJSON(req, limit = 300 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function send(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

async function createRoom(req, res) {
  const body = await readJSON(req, 4096);
  if (HOST_PASSWORD && body.password !== HOST_PASSWORD) return send(res, 401, { error: 'wrong_password' });
  const ip = ipOf(req), now = Date.now();
  // resuming an existing room you host
  if (validCode(body.code) && body.hostKey) {
    const r = rooms.get(body.code);
    if (r && r.hostKey === body.hostKey) { r.lastActive = now; return send(res, 200, { code: r.code, hostKey: r.hostKey, resumed: true }); }
    if (!r) { rooms.set(body.code, { code: body.code, hostKey: body.hostKey, peers: new Map(), aiCalls: body.aiCalls | 0, created: now, lastActive: now }); return send(res, 200, { code: body.code, hostKey: body.hostKey, resumed: true }); }
  }
  const recent = (ipRooms.get(ip) || []).filter(t => now - t < 24 * 3600e3);
  if (recent.length >= MAX_ROOMS_PER_IP_PER_DAY) return send(res, 429, { error: 'too_many_rooms' });
  let code; do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join(''); } while (rooms.has(code));
  const hostKey = crypto.randomBytes(18).toString('base64url');
  rooms.set(code, { code, hostKey, peers: new Map(), aiCalls: 0, created: now, lastActive: now });
  recent.push(now); ipRooms.set(ip, recent);
  send(res, 200, { code, hostKey, needsPassword: !!HOST_PASSWORD });
}

/* ---------------- AI DM ---------------- */
function extractJSON(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
async function callClaude(prompt, fast) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: fast ? MODEL_FAST : MODEL_SMART, max_tokens: 1600, temperature: 1, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const type = data?.error?.type || '';
    const code = r.status === 429 || type === 'rate_limit_error' ? 'rate_limited' : r.status === 529 || type === 'overloaded_error' ? 'overloaded' : r.status === 401 ? 'bad_key' : r.status === 400 && /credit/i.test(data?.error?.message || '') ? 'no_credit' : 'upstream_error';
    const e = new Error(data?.error?.message || 'API error'); e.code = code; throw e;
  }
  return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
}
async function dm(req, res) {
  const body = await readJSON(req);
  const room = getRoom(body.code);
  if (!room || room.hostKey !== body.hostKey) return send(res, 403, { error: 'not_host' });
  if (typeof body.prompt !== 'string' || body.prompt.length > 200000) return send(res, 400, { error: 'bad_prompt' });
  if (room.aiCalls >= MAX_AI_CALLS_PER_ROOM) return send(res, 429, { error: 'room_limit' });
  room.aiCalls++; room.lastActive = Date.now();
  if (MOCK) return send(res, 200, { data: mockDM(body.prompt) });
  try {
    let text = await callClaude(body.prompt, !!body.fast), data = extractJSON(text);
    if (!data) { text = await callClaude(body.prompt + '\n\nIMPORTANT: Reply with ONLY one valid JSON object, no other text.', true); data = extractJSON(text); }
    if (!data) return send(res, 502, { error: 'invalid_json' });
    send(res, 200, { data });
  } catch (e) {
    console.error('[dm]', e.code, e.message);
    send(res, e.code === 'rate_limited' || e.code === 'overloaded' ? 503 : 502, { error: e.code || 'upstream_error' });
  }
}

// Canned replies so the game can be tested without an API key (MOCK_DM=1)
function mockDM(prompt) {
  const ids = [...prompt.matchAll(/- id (p[a-z0-9]+):/g)].map(m => m[1]);
  const pitchIds = [...prompt.matchAll(/- from id (p[a-z0-9]+)/g)].map(m => m[1]);
  const words = [...prompt.matchAll(/^- "(.+?)" \(answer to/gm)].map(m => m[1]);
  const w = i => words[i % Math.max(1, words.length)] || 'the Soggy Flagon';
  if (prompt.includes('TASK: Open the adventure')) return {
    title: `The Night of ${w(0)}`,
    intros: ids.map(id => ({ id, line: 'Smells like regret and cheap mead, and somehow everyone is into it.' })),
    narration: `[MOCK DM] You stumble into ${w(0)}, a tavern so sticky your boots squeak. The barkeep is slicing ${w(1)}.\n\nA hooded figure in the corner whispers that the deed to this dump is gone.`,
    question: 'What do you do first?', recap: 'The party arrived at the tavern and learned the deed is missing.' };
  if (prompt.includes('Turn ') && prompt.includes('options')) return {
    options: [...pitchIds.slice(0, 3).map((id, i) => ({ text: `Punched-up pitch number ${i + 1}`, by: id, skill: ['Persuasion', 'Stealth', 'Athletics'][i], dc: 12 + i })),
      { text: 'Lick the mysterious glowing mug', by: null, skill: 'Medicine', dc: 14 }] };
  if (prompt.includes('THE WHOLE PARTY IS DOWN')) return { narration: '[MOCK DM] Everyone died. It was hilarious.', awards: ids.map(id => ({ id, title: 'Fastest Corpse', why: 'Died first, complained most.' })) };
  if (prompt.includes('COMBAT ROUND')) {
    if (prompt.includes('epilogue')) return { narration: '[MOCK DM] The boss explodes into a fine mist.\n\nYou are heroes, technically.', awards: ids.map(id => ({ id, title: 'Chaos Goblin', why: 'Rolled like a maniac.' })), recap: 'Boss defeated.' };
    return { narration: '[MOCK DM] Blades fly, someone screams, the foe spits a tooth.', question: 'Hit it again?', hp: ids.slice(0, 1).map(id => ({ id, change: -3 })), recap: 'A round of combat.' };
  }
  const foe = prompt.includes('final showdown begins') ? { name: 'The Cheese God', hp: 50, ac: 15 } : prompt.includes('a fight breaks out') ? { name: 'Goon Named ' + w(2), hp: 26, ac: 13 } : undefined;
  return { narration: `[MOCK DM] The roll lands. Chaos follows, involving ${w(3)}.\n\nThe story lurches forward.`, question: foe ? 'How do you open this fight?' : 'What now?', hp: [], inspiration: ids[0] || null, recap: 'Something happened.', ...(foe ? { foe } : {}) };
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/room') return await createRoom(req, res);
    if (req.method === 'POST' && req.url === '/api/dm') return await dm(req, res);
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true, mock: MOCK, rooms: rooms.size, password: !!HOST_PASSWORD });
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end();
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG });
wss.on('connection', ws => {
  ws._alive = true; ws.on('pong', () => ws._alive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      const room = getRoom(m.code);
      if (!room) return ws.send(JSON.stringify({ t: 'error', error: 'no_room' }));
      if (room.peers.size >= MAX_PEERS) return ws.send(JSON.stringify({ t: 'error', error: 'room_full' }));
      leave(ws);
      const presence = (m.presence && typeof m.presence === 'object') ? m.presence : {};
      if (presence.h && m.hostKey !== room.hostKey) delete presence.h; // only the real host may speak as host
      ws._room = room; ws._isHost = m.hostKey === room.hostKey;
      room.peers.set(ws, { peer: crypto.randomBytes(6).toString('hex'), presence, updatedAt: Date.now() });
      room.lastActive = Date.now();
      ws.send(JSON.stringify({ t: 'joined', code: room.code }));
      broadcastPeers(room);
    } else if (m.t === 'presence' && ws._room) {
      const me = ws._room.peers.get(ws); if (!me || !m.patch || typeof m.patch !== 'object') return;
      const patch = { ...m.patch }; if (!ws._isHost) { delete patch.h; delete patch.s; }
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete me.presence[k]; else me.presence[k] = v; }
      me.updatedAt = Date.now(); ws._room.lastActive = me.updatedAt;
      broadcastPeers(ws._room);
    }
  });
  ws.on('close', () => leave(ws));
});
// drop dead connections so phones that lock their screen don't linger forever
setInterval(() => { for (const ws of wss.clients) { if (!ws._alive) { ws.terminate(); continue; } ws._alive = false; ws.ping(); } }, 25000).unref();

server.listen(PORT, () => console.log(`Dummies & Dragons on http://localhost:${PORT}  (${MOCK ? 'MOCK DM, no API key' : 'live DM: ' + MODEL_SMART})`));
