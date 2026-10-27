// 群聊前端：无框架，纯浏览器 JS。
'use strict';

const params = new URLSearchParams(location.search);
const ROOM = (params.get('room') || 'main').slice(0, 64);
const NAME_KEY = 'agc_name_' + ROOM;

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
let ws = null;
let myName = localStorage.getItem(NAME_KEY) || '';
let members = [];
let pendingImage = null; // { dataUrl, name }
let reconnectTimer = null;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeStr(iso) {
  try { return new Date(iso).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return ''; }
}

function renderMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg' + (m.senderType === 'ai' ? ' ai' : '') + (m.senderType === 'system' ? ' system' : '')
    + (m.senderType === 'human' && m.senderName === myName ? ' mine' : '');
  let html = '<div class="who">' + esc(m.senderName) + (m.senderType === 'ai' ? ' · AI' : '') + '</div>';
  if (m.text) html += '<div class="text">' + esc(m.text) + '</div>';
  if (m.imageUrl) html += '<img src="' + esc(m.imageUrl) + '" alt="图片">';
  html += '<div class="time">' + timeStr(m.time) + '</div>';
  div.innerHTML = html;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderHumans(humans) {
  $('humanList').innerHTML = humans.map((h) => '<li><span>' + esc(h) + (h === myName ? '（我）' : '') + '</span></li>').join('')
    || '<li class="mini">还没人</li>';
}

function renderMembers() {
  $('aiList').innerHTML = members.map((m) => {
    const dot = !m.enabled ? 'off' : (m.status === 'error' ? 'err' : 'on');
    return '<li class="ai" data-name="' + esc(m.name) + '"><span><span class="dot ' + dot + '"></span>'
      + esc(m.name) + '</span><span class="mini">' + (m.enabled ? m.model : '已关') + '</span></li>';
  }).join('') || '<li class="mini">还没 AI，点右上「管理 AI」添加</li>';
  document.querySelectorAll('#aiList li.ai').forEach((li) => {
    li.onclick = () => {
      const input = $('textInput');
      input.value = '@' + li.dataset.name + ' ' + input.value;
      input.focus();
    };
  });
}

function renderAdminList() {
  $('adminList').innerHTML = members.map((m) => {
    return '<li><div><b>' + esc(m.name) + '</b> <span class="mini">' + esc(m.model) + ' · key ' + esc(m.keyMask)
      + (m.vision ? ' · 能看图' : ' · 不看图') + '</span></div>'
      + '<div class="mini">状态：' + esc(m.statusText || (m.status === 'ok' ? '已接通' : m.status === 'error' ? '失败' : '未测试'))
      + (m.lastTested ? '（' + timeStr(m.lastTested) + '）' : '') + '</div>'
      + '<div class="mini" style="word-break:break-all">' + esc(m.baseUrl) + '</div>'
      + '<div class="row">'
      + '<button data-act="toggle" data-id="' + m.id + '">' + (m.enabled ? '关闭' : '开启') + '</button>'
      + '<button data-act="test" data-id="' + m.id + '">测试连接</button>'
      + '<button data-act="del" data-id="' + m.id + '">移出</button>'
      + '</div></li>';
  }).join('') || '<li class="mini">还没有成员</li>';
  document.querySelectorAll('#adminList [data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id, act = btn.dataset.act;
      if (act === 'del' && !confirm('确定把这个 AI 移出群吗？')) return;
      if (act === 'toggle') {
        const m = members.find((x) => x.id === id);
        await api('/api/members/' + id, 'PATCH', { enabled: !m.enabled });
      } else if (act === 'test') {
        btn.disabled = true; btn.textContent = '测试中…';
        const r = await api('/api/members/' + id + '/test', 'POST', {});
        alert(r.ok ? '已接通' : ('没接通：' + (r.message || '未知错误')));
        btn.disabled = false; btn.textContent = '测试连接';
      } else if (act === 'del') {
        await api('/api/members/' + id, 'DELETE');
      }
      await loadMembers();
    };
  });
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function loadMembers() {
  const r = await api('/api/members', 'GET');
  members = r.members || [];
  renderMembers();
  renderAdminList();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: ROOM, name: myName }));
  ws.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (_) { return; }
    if (d.type === 'init') {
      myName = d.you;
      localStorage.setItem(NAME_KEY, myName);
      $('roomName').textContent = '群聊 · ' + d.room;
      $('roomLink').textContent = location.href;
      $('nameInput').value = myName;
      messagesEl.innerHTML = '';
      (d.history || []).forEach(renderMessage);
      members = d.members || [];
      renderMembers();
      renderAdminList();
      renderHumans(d.humans || []);
    } else if (d.type === 'message') {
      renderMessage(d.message);
    } else if (d.type === 'presence') {
      renderHumans(d.humans || []);
    } else if (d.type === 'members') {
      members = d.members || [];
      renderMembers();
      renderAdminList();
    } else if (d.type === 'error') {
      alert(d.text);
    }
  };
  ws.onclose = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };
}

function sendChat() {
  if (!ws || ws.readyState !== 1) { alert('还没连上，稍等一下'); return; }
  const text = $('textInput').value.trim();
  if (!text && !pendingImage) return;
  ws.send(JSON.stringify({ type: 'chat', text, imageDataUrl: pendingImage ? pendingImage.dataUrl : null }));
  $('textInput').value = '';
  clearImage();
}

function clearImage() {
  pendingImage = null;
  $('imgInput').value = '';
  $('imgPreview').style.display = 'none';
}

$('sendBtn').onclick = sendChat;
$('textInput').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
$('renameBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name || !ws || ws.readyState !== 1) return;
  myName = name;
  localStorage.setItem(NAME_KEY, name);
  ws.send(JSON.stringify({ type: 'rename', name }));
};
$('copyLinkBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); alert('群链接已复制，发给谁、谁点开就自动进群'); }
  catch (_) {
    prompt('复制这条群链接发给朋友：', location.href);
  }
};
$('imgInput').onchange = () => {
  const f = $('imgInput').files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) { alert('图片超过 5MB，换张小的'); clearImage(); return; }
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = { dataUrl: reader.result, name: f.name };
    $('imgPreviewName').textContent = '已选图片：' + f.name;
    $('imgPreview').style.display = 'block';
  };
  reader.readAsDataURL(f);
};
$('imgRemoveBtn').onclick = clearImage;

// 管理面板
$('adminBtn').onclick = () => { $('adminPanel').style.display = 'block'; $('adminBackdrop').style.display = 'block'; loadMembers(); };
$('adminCloseBtn').onclick = () => { $('adminPanel').style.display = 'none'; $('adminBackdrop').style.display = 'none'; };
$('adminBackdrop').onclick = () => { $('adminPanel').style.display = 'none'; $('adminBackdrop').style.display = 'none'; };

$('testBtn').onclick = async () => {
  const baseUrl = $('fBase').value.trim(), key = $('fKey').value.trim();
  const msg = $('formMsg');
  if (!baseUrl || !key) { msg.className = 'form-msg err'; msg.textContent = '先填 API 链接和 key'; return; }
  msg.className = 'form-msg'; msg.textContent = '正在测试…';
  $('testBtn').disabled = true;
  try {
    const r = await api('/api/test-endpoint', 'POST', { baseUrl, key });
    if (r.ok && r.models && r.models.length) {
      msg.className = 'form-msg ok'; msg.textContent = '已接通，拉到 ' + r.models.length + ' 个模型，点下拉选一个';
      const sel = $('fModelSelect');
      sel.style.display = 'block';
      sel.innerHTML = r.models.map((m) => '<option>' + esc(m) + '</option>').join('');
      $('fModel').value = r.models[0];
      sel.onchange = () => { $('fModel').value = sel.value; };
    } else {
      msg.className = 'form-msg err'; msg.textContent = r.message || '没接通';
    }
  } catch (e) {
    msg.className = 'form-msg err'; msg.textContent = '请求失败：' + e.message;
  }
  $('testBtn').disabled = false;
};

$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('formMsg');
  const body = {
    name: $('fName').value.trim(), baseUrl: $('fBase').value.trim(),
    key: $('fKey').value.trim(), model: $('fModel').value.trim(),
    vision: $('fVision').checked,
  };
  if (!body.name || !body.baseUrl || !body.key || !body.model) {
    msg.className = 'form-msg err'; msg.textContent = '名字、API 链接、key、模型都要填';
    return;
  }
  const r = await api('/api/members', 'POST', body);
  if (!r.ok) { msg.className = 'form-msg err'; msg.textContent = r.message || '添加失败'; return; }
  msg.className = 'form-msg ok'; msg.textContent = '已添加到群里';
  $('addForm').reset();
  $('fModelSelect').style.display = 'none';
  await loadMembers();
};

$('roomLink').textContent = location.href;
connect();
