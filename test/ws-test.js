// 本地端到端验证：对跑起来的 server 做一遍基本流程。
// 用法：先起 mock（MOCK_PORT=3123 node test/mock-provider.js），
// 再起 server（PORT=3100 DATA_DIR=/tmp/agc-test-data node server.js），
// 然后跑：APP_URL=http://127.0.0.1:3100 MOCK_URL=http://127.0.0.1:3123 node test/ws-test.js
'use strict';
const WebSocket = require('ws');

const APP = (process.env.APP_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const MOCK = (process.env.MOCK_URL || 'http://127.0.0.1:3123').replace(/\/+$/, '');
const WS_URL = APP.replace(/^http/, 'ws') + '/ws';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' —— ' + extra : '')); }
}

async function api(path, method, body) {
  const res = await fetch(APP + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch (_) {} });
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

function waitFor(inbox, pred, timeoutMs, fromIndex) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      for (let i = fromIndex || 0; i < inbox.length; i++) {
        if (pred(inbox[i])) { clearInterval(timer); resolve(inbox[i]); return; }
      }
      if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error('timeout')); }
    }, 50);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. 首页
  const home = await fetch(APP + '/');
  const homeText = await home.text();
  check('首页返回 HTML', home.status === 200 && homeText.includes('AI 群聊'));

  // 2. 进群 + 访客名
  const c1 = await connectClient();
  c1.ws.send(JSON.stringify({ type: 'join', room: 'test-room', name: '' }));
  let init;
  try { init = await waitFor(c1.inbox, (d) => d.type === 'init', 5000); } catch (e) { init = null; }
  check('进群自动分配访客名', !!init && /^访客\d{4}$/.test(init.you), init ? init.you : '无 init');
  const me = init ? init.you : '访客0000';

  // 3. 改名
  c1.ws.send(JSON.stringify({ type: 'rename', name: '测试员' }));
  try {
    await waitFor(c1.inbox, (d) => d.type === 'message' && d.message.senderType === 'system' && d.message.text.includes('改名为'), 5000);
    check('改名后群里有提示', true);
  } catch (e) { check('改名后群里有提示', false); }

  // 4. 无 AI 成员时发消息 → 诚实提示
  let idx = c1.inbox.length;
  c1.ws.send(JSON.stringify({ type: 'chat', text: '大家好' }));
  try {
    await waitFor(c1.inbox, (d) => d.type === 'message' && d.message.senderType === 'system' && d.message.text.includes('没有开启的 AI 成员'), 5000, idx);
    check('无开启成员时如实提示', true);
  } catch (e) { check('无开启成员时如实提示', false); }

  // 5. 添加成员（key 不外泄）
  const add1 = await api('/api/members', 'POST', { name: 'mock-chat', baseUrl: MOCK + '/v1', key: 'test-key', model: 'mock-chat', vision: false });
  check('添加 AI 成员成功', !!add1.ok && !!add1.member && add1.member.id);
  check('成员接口不返回完整 key', JSON.stringify(add1).indexOf('test-key') === -1, JSON.stringify(add1).slice(0, 200));

  // 6. 测试端点拉回模型
  const t1 = await api('/api/test-endpoint', 'POST', { baseUrl: MOCK + '/v1', key: 'test-key' });
  check('测试端点拉回模型列表', !!t1.ok && Array.isArray(t1.models) && t1.models.includes('mock-chat'), JSON.stringify(t1));

  // 7. 全体回复
  idx = c1.inbox.length;
  c1.ws.send(JSON.stringify({ type: 'chat', text: '请介绍一下自己' }));
  try {
    const m = await waitFor(c1.inbox, (d) => d.type === 'message' && d.message.senderType === 'ai' && d.message.senderName === 'mock-chat', 8000, idx);
    check('AI 成员正常回复', m.message.text.includes('mock 回复'), m.message.text);
  } catch (e) { check('AI 成员正常回复', false); }

  // 8. 加第二个成员，@单个只让它回
  const add2 = await api('/api/members', 'POST', { name: 'mock-vision', baseUrl: MOCK + '/v1', key: 'test-key', model: 'mock-vision', vision: true });
  check('添加第二个 AI 成员成功', !!add2.ok);
  idx = c1.inbox.length;
  c1.ws.send(JSON.stringify({ type: 'chat', text: '@mock-vision 只问你' }));
  await sleep(1500);
  const got = c1.inbox.slice(idx).filter((d) => d.type === 'message' && d.message.senderType === 'ai');
  check('@单个只让它回', got.length >= 1 && got.every((d) => d.message.senderName === 'mock-vision'), JSON.stringify(got.map((d) => d.message.senderName)));

  // 9. 不@则全体回
  idx = c1.inbox.length;
  c1.ws.send(JSON.stringify({ type: 'chat', text: '大家都说说' }));
  await sleep(1500);
  const both = c1.inbox.slice(idx).filter((d) => d.type === 'message' && d.message.senderType === 'ai').map((d) => d.message.senderName);
  check('不@则全体 AI 一起回', both.includes('mock-chat') && both.includes('mock-vision'), JSON.stringify(both));

  // 10. 图片：不看图的成员出提示，看图的成员看到图
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  idx = c1.inbox.length;
  c1.ws.send(JSON.stringify({ type: 'chat', text: '看这张图', imageDataUrl: png1x1 }));
  await sleep(2000);
  const seg = c1.inbox.slice(idx);
  const visionNote = seg.some((d) => d.type === 'message' && d.message.senderType === 'system' && d.message.text.includes('看不了图片'));
  const visionReply = seg.some((d) => d.type === 'message' && d.message.senderType === 'ai' && d.message.senderName === 'mock-vision' && d.message.text.includes('看到图片'));
  check('不看图的 AI 出文字说明', visionNote);
  check('能看图的 AI 收到图片并回复', visionReply);

  // 11. 坏 key → 诚实失败，不伪造
  await api('/api/members', 'POST', { name: 'mock-bad', baseUrl: MOCK + '/v1bad', key: 'bad-key', model: 'mock-chat', vision: false });
  idx = c1.inbox.length;
  c1.ws.send(JSON.stringify({ type: 'chat', text: '@mock-bad 测试坏 key' }));
  let badNote = false, badFake = false;
  try {
    await waitFor(c1.inbox, (d) => d.type === 'message' && d.message.senderType === 'system' && d.message.text.includes('mock-bad') && d.message.text.includes('key 无效'), 8000, idx);
    badNote = true;
  } catch (e) { /* no */ }
  await sleep(500);
  badFake = c1.inbox.slice(idx).some((d) => d.type === 'message' && d.message.senderType === 'ai' && d.message.senderName === 'mock-bad');
  check('坏 key 如实提示 key 无效', badNote);
  check('坏 key 不伪造 AI 回复', !badFake);

  // 12. 连不上的端点
  const tBad = await api('/api/test-endpoint', 'POST', { baseUrl: 'http://127.0.0.1:39999/v1', key: 'x' });
  check('连不上的端点如实报错', !tBad.ok && (tBad.message || '').includes('连不上'), JSON.stringify(tBad));

  // 13. 成员列表不外泄 key
  const list = await api('/api/members', 'GET');
  check('成员列表不外泄完整 key', JSON.stringify(list).indexOf('test-key') === -1 && JSON.stringify(list).indexOf('bad-key') === -1);

  // 14. 重进可回看历史
  const c2 = await connectClient();
  c2.ws.send(JSON.stringify({ type: 'join', room: 'test-room', name: '回访者' }));
  let init2;
  try { init2 = await waitFor(c2.inbox, (d) => d.type === 'init', 5000); } catch (e) { init2 = null; }
  const histText = (init2 ? init2.history : []).map((m) => m.text || '').join('\n');
  check('重进可回看历史', !!init2 && histText.includes('大家好') && histText.includes('mock 回复'), '历史条数：' + (init2 ? init2.history.length : 0));

  c1.ws.close(); c2.ws.close();
  console.log('\n结果：通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本出错：', e); process.exit(1); });
