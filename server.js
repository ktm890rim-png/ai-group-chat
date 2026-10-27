// AI 群聊：通用链接即邀请的群聊 Web 应用。
// 启动：node server.js；端口：PORT 环境变量（默认 3000）。
// 设计要点：
// - 不做注册登录：打开链接自动进群，自动分配访客名，进群后可改名。
// - AI 成员不预置任何固定名单：全部由用户在管理界面贴 OpenAI 兼容 base URL + key 接入。
// - key 只存在服务端数据文件里，任何接口都不向前端返回完整 key。
// - 失败诚实显示：key 无效、连不上、无开启成员时，群里如实提示，绝不伪造 AI 回复。
// - 不做交易下单，不碰任何交易账号，不索要任何密码。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_MESSAGES_PER_ROOM = 500;
const HISTORY_ON_JOIN = 200;
const MAX_TEXT_LEN = 4000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const AI_TIMEOUT_MS = 60000;
const TEST_TIMEOUT_MS = 15000;
const AI_CONTEXT_MSGS = 20;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------- 数据 ----------------
let store = { version: 1, members: [], rooms: {} };
try {
  if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('[data] 旧数据损坏，从空数据启动：', e.message);
  store = { version: 1, members: [], rooms: {} };
}
if (!store.members) store.members = [];
if (!store.rooms) store.rooms = {};

function saveStore() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function getRoom(roomId) {
  if (!store.rooms[roomId]) store.rooms[roomId] = { messages: [] };
  return store.rooms[roomId];
}

function pushMessage(roomId, msg) {
  const room = getRoom(roomId);
  room.messages.push(msg);
  while (room.messages.length > MAX_MESSAGES_PER_ROOM) room.messages.shift();
  saveStore();
}

// ---------------- 工具 ----------------
function uid() {
  return crypto.randomUUID();
}

function nowISO() {
  return new Date().toISOString();
}

// base URL 归一化：去尾斜杠，去掉用户可能顺手贴上的 /chat/completions 或 /models 后缀。
function normalizeBase(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (u.endsWith('/chat/completions')) u = u.slice(0, -'/chat/completions'.length);
  if (u.endsWith('/models')) u = u.slice(0, -'/models'.length);
  return u;
}

function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 4) return '••••';
  return '••••' + k.slice(-4);
}

function publicMember(m) {
  return {
    id: m.id, name: m.name, baseUrl: m.baseUrl, model: m.model,
    vision: !!m.vision, enabled: !!m.enabled,
    status: m.status || 'untested', statusText: m.statusText || '',
    lastTested: m.lastTested || '', keyMask: maskKey(m.key),
  };
}

function classifyError(err, status) {
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return { kind: 'invalid_key', text: 'key 无效或没有权限' };
    if (status === 404) return { kind: 'bad_endpoint', text: '接口地址不对（404）' };
    if (status === 429) return { kind: 'rate_limited', text: '接口被限流了' };
    return { kind: 'provider_error', text: '接口返回错误（HTTP ' + status + '）' };
  }
  const msg = String((err && err.message) || err || '');
  if (/aborted|timeout|timed out/i.test(msg)) return { kind: 'unreachable', text: '连不上这个链接（超时）' };
  return { kind: 'unreachable', text: '连不上这个链接' };
}

// ---------------- AI 调用（OpenAI 兼容） ----------------
async function testEndpoint(baseUrl, key) {
  const base = normalizeBase(baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(base + '/models', {
      headers: { Authorization: 'Bearer ' + key },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: 'invalid_key', message: 'key 无效或没有权限' };
    }
    if (res.status === 404) {
      return { ok: false, kind: 'models_unavailable', message: '接口通了，但没有模型列表接口，请手动填写模型名' };
    }
    if (!res.ok) {
      return { ok: false, kind: 'provider_error', message: '接口返回错误（HTTP ' + res.status + '）' };
    }
    const body = await res.json();
    const models = Array.isArray(body.data) ? body.data.map((d) => d.id).filter(Boolean) : [];
    return { ok: true, models };
  } catch (e) {
    const c = classifyError(e);
    return { ok: false, kind: c.kind, message: c.text };
  } finally {
    clearTimeout(timer);
  }
}

async function chatCompletion(member, contextMsgs, userText, imageDataUrl) {
  const base = normalizeBase(member.baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  let userContent = userText;
  if (imageDataUrl && member.vision) {
    userContent = [
      { type: 'text', text: userText || '请看这张图' },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ];
  }
  const messages = [
    { role: 'system', content: '你是群聊成员「' + member.name + '」，用中文简短回复，像在群里聊天。' },
    ...contextMsgs,
    { role: 'user', content: userContent },
  ];
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + member.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: member.model, messages, temperature: 0.7, max_tokens: 1024 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const c = classifyError(null, res.status);
      return { ok: false, kind: c.kind, message: c.text };
    }
    const body = await res.json();
    const text = body && body.choices && body.choices[0] && body.choices[0].message
      ? (body.choices[0].message.content || '')
      : '';
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, kind: 'bad_response', message: '接口返回格式不对' };
    }
    return { ok: true, text: text.trim() };
  } catch (e) {
    const c = classifyError(e);
    return { ok: false, kind: c.kind, message: c.text };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- HTTP：静态 + REST ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > (limit || 1024 * 1024)) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(u.pathname);

    // 静态页面
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/static/')) {
      const file = path.join(PUBLIC_DIR, pathname.slice('/static/'.length));
      if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
      serveFile(res, file);
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
      const file = path.join(UPLOAD_DIR, path.basename(pathname));
      serveFile(res, file);
      return;
    }

    // REST：成员管理（返回的 key 一律掩码）
    if (pathname === '/api/members' && req.method === 'GET') {
      sendJson(res, 200, { members: store.members.map(publicMember) });
      return;
    }
    if (pathname === '/api/test-endpoint' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.baseUrl || !body.key) { sendJson(res, 400, { ok: false, message: '请填写 API 链接和 key' }); return; }
      const r = await testEndpoint(body.baseUrl, body.key);
      sendJson(res, 200, r);
      return;
    }
    if (pathname === '/api/members' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const baseUrl = normalizeBase(body.baseUrl);
      const key = String(body.key || '').trim();
      const model = String(body.model || '').trim();
      if (!name || !baseUrl || !key || !model) {
        sendJson(res, 400, { ok: false, message: '名字、API 链接、key、模型都要填' });
        return;
      }
      if (!/^https?:\/\//.test(baseUrl)) { sendJson(res, 400, { ok: false, message: 'API 链接要以 http:// 或 https:// 开头' }); return; }
      const m = {
        id: uid(), name, baseUrl, key, model, vision: !!body.vision,
        enabled: true, status: 'untested', statusText: '', lastTested: '',
      };
      store.members.push(m);
      saveStore();
      broadcastMembers();
      sendJson(res, 200, { ok: true, member: publicMember(m) });
      return;
    }
    const memberMatch = pathname.match(/^\/api\/members\/([^/]+)(\/test)?$/);
    if (memberMatch) {
      const m = store.members.find((x) => x.id === memberMatch[1]);
      if (!m) { sendJson(res, 404, { ok: false, message: '成员不存在' }); return; }
      if (memberMatch[2] === '/test' && req.method === 'POST') {
        const r = await testEndpoint(m.baseUrl, m.key);
        m.status = r.ok ? 'ok' : 'error';
        m.statusText = r.ok ? '已接通' : r.message;
        m.lastTested = nowISO();
        saveStore();
        broadcastMembers();
        sendJson(res, 200, r);
        return;
      }
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        if (typeof body.name === 'string' && body.name.trim()) m.name = body.name.trim();
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) m.baseUrl = normalizeBase(body.baseUrl);
        if (typeof body.model === 'string' && body.model.trim()) m.model = body.model.trim();
        if (typeof body.key === 'string' && body.key.trim()) m.key = body.key.trim();
        if (typeof body.vision === 'boolean') m.vision = body.vision;
        if (typeof body.enabled === 'boolean') m.enabled = body.enabled;
        saveStore();
        broadcastMembers();
        sendJson(res, 200, { ok: true, member: publicMember(m) });
        return;
      }
      if (req.method === 'DELETE') {
        store.members = store.members.filter((x) => x.id !== m.id);
        saveStore();
        broadcastMembers();
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error('[http]', e);
    try { sendJson(res, 500, { ok: false, message: '服务器出错' }); } catch (_) {}
  }
});

// ---------------- WebSocket：实时群聊 ----------------
const wss = new WebSocketServer({ server, maxPayload: 6 * 1024 * 1024 });
const rooms = new Map(); // roomId -> Set(ws)

function roomSockets(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

function send(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {}
}

function broadcast(roomId, obj) {
  for (const ws of roomSockets(roomId)) send(ws, obj);
}

function broadcastMembers() {
  const payload = { type: 'members', members: store.members.map(publicMember) };
  for (const set of rooms.values()) for (const ws of set) send(ws, payload);
}

function humansIn(roomId) {
  const names = [];
  for (const ws of roomSockets(roomId)) if (ws.userName) names.push(ws.userName);
  return names;
}

function broadcastPresence(roomId) {
  broadcast(roomId, { type: 'presence', humans: humansIn(roomId) });
}

function guestName(roomId) {
  const taken = new Set(humansIn(roomId));
  let name;
  do { name = '访客' + Math.floor(1000 + Math.random() * 9000); } while (taken.has(name));
  return name;
}

function systemMsg(roomId, text) {
  const msg = { id: uid(), room: roomId, senderType: 'system', senderName: '系统', text, time: nowISO() };
  pushMessage(roomId, msg);
  broadcast(roomId, { type: 'message', message: msg });
  return msg;
}

// 解析开头的 @成员名：@到才只让它回；@不到就全体回。
function mentionTarget(text) {
  const t = text.trim();
  if (!t.startsWith('@')) return null;
  const name = t.slice(1).split(/\s+/)[0];
  if (!name) return null;
  return store.members.find((m) => m.enabled && m.name === name) || null;
}

function buildContext(roomId) {
  const msgs = getRoom(roomId).messages.filter((m) => m.senderType !== 'system').slice(-AI_CONTEXT_MSGS);
  return msgs.map((m) => ({
    role: m.senderType === 'ai' ? 'assistant' : 'user',
    content: (m.senderName + '：' + (m.text || (m.imageUrl ? '[图片]' : ''))).slice(0, 2000),
  }));
}

async function triggerAI(roomId, userMsg) {
  const targets = (() => {
    const one = userMsg.text ? mentionTarget(userMsg.text) : null;
    if (one) return [one];
    return store.members.filter((m) => m.enabled);
  })();
  if (targets.length === 0) {
    systemMsg(roomId, '没有开启的 AI 成员，先去「管理 AI」里添加并开启一个。');
    return;
  }
  const context = buildContext(roomId);
  for (const member of targets) {
    if (userMsg.imageUrl && !member.vision) {
      systemMsg(roomId, '「' + member.name + '」看不了图片，已只按文字回复。');
    }
    const r = await chatCompletion(member, context, userMsg.text || '', userMsg.imageDataUrl || null);
    if (!r.ok) {
      systemMsg(roomId, '「' + member.name + '」回复失败：' + r.message + '。');
      continue;
    }
    const msg = {
      id: uid(), room: roomId, senderType: 'ai', memberId: member.id,
      senderName: member.name, text: r.text, time: nowISO(),
    };
    pushMessage(roomId, msg);
    broadcast(roomId, { type: 'message', message: msg });
  }
}

function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = uid() + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  return '/uploads/' + file;
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.userName = null;

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (_) { return; }

    if (data.type === 'join') {
      const roomId = String(data.room || 'main').slice(0, 64) || 'main';
      ws.roomId = roomId;
      ws.userName = String(data.name || '').trim() || guestName(roomId);
      roomSockets(roomId).add(ws);
      send(ws, {
        type: 'init', you: ws.userName, room: roomId,
        history: getRoom(roomId).messages.slice(-HISTORY_ON_JOIN),
        members: store.members.map(publicMember), humans: humansIn(roomId),
      });
      broadcastPresence(roomId);
      return;
    }
    if (!ws.roomId) return;

    if (data.type === 'rename') {
      const old = ws.userName;
      const name = String(data.name || '').trim().slice(0, 24);
      if (!name || name === old) return;
      ws.userName = name;
      systemMsg(ws.roomId, '「' + old + '」改名为「' + name + '」。');
      broadcastPresence(ws.roomId);
      return;
    }

    if (data.type === 'chat') {
      const text = String(data.text || '').slice(0, MAX_TEXT_LEN).trim();
      let imageUrl = null;
      let imageDataUrl = null;
      if (data.imageDataUrl) {
        imageUrl = saveImage(data.imageDataUrl);
        if (!imageUrl) { send(ws, { type: 'error', text: '图片不对或超过 5MB，没发出去。' }); return; }
        imageDataUrl = data.imageDataUrl;
      }
      if (!text && !imageUrl) return;
      const msg = {
        id: uid(), room: ws.roomId, senderType: 'human',
        senderName: ws.userName, text, imageUrl, time: nowISO(),
      };
      pushMessage(ws.roomId, msg);
      broadcast(ws.roomId, { type: 'message', message: msg });
      // AI 回复是异步的，不阻塞；imageDataUrl 只用于本次调用，不落盘。
      triggerAI(ws.roomId, { ...msg, imageDataUrl }).catch((e) => {
        console.error('[ai]', e);
        systemMsg(ws.roomId, 'AI 回复出错了，请稍后再试。');
      });
      return;
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      roomSockets(ws.roomId).delete(ws);
      broadcastPresence(ws.roomId);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('[ai-group-chat] 听在 http://' + HOST + ':' + PORT + '/ ，数据目录 ' + DATA_DIR);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
