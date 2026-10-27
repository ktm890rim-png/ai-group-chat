// 本地验证用的模拟 OpenAI 兼容接口：只跑测试用，部署不需要它。
// /v1：正常接口；/v1bad：永远返回 401（模拟 key 无效）。
'use strict';
const http = require('http');

const PORT = parseInt(process.env.MOCK_PORT || '3123', 10);

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (_) { resolve({}); } });
  });
}

function reply(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/v1bad')) {
    reply(res, 401, { error: { message: 'Incorrect API key provided' } });
    return;
  }
  if (u.pathname === '/v1/models' && req.method === 'GET') {
    if (!req.headers.authorization) { reply(res, 401, { error: { message: 'missing key' } }); return; }
    reply(res, 200, { data: [{ id: 'mock-chat' }, { id: 'mock-vision' }] });
    return;
  }
  if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!req.headers.authorization) { reply(res, 401, { error: { message: 'missing key' } }); return; }
    const body = await readBody(req);
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = msgs[msgs.length - 1] || {};
    let text = '';
    let sawImage = false;
    if (Array.isArray(last.content)) {
      for (const p of last.content) {
        if (p.type === 'text') text += p.text || '';
        if (p.type === 'image_url') sawImage = true;
      }
    } else {
      text = String(last.content || '');
    }
    const out = sawImage ? ('mock 看到图片了：' + text) : ('mock 回复：' + text);
    reply(res, 200, { choices: [{ message: { role: 'assistant', content: out } }] });
    return;
  }
  reply(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, '127.0.0.1', () => console.log('[mock] 听在 127.0.0.1:' + PORT));
