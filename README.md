# AI 群聊

一条通用链接即邀请的群聊 Web 应用：链接发给谁，谁点开就自动进群，不用注册登录。
群成员分两类：真人（链接进来的朋友）和 AI 成员。
AI 成员不预置任何固定名单，全部由用户在「管理 AI」里贴任意 OpenAI 兼容的 API 链接 + key 接入。

本程序只做群聊：不做交易下单，不碰任何交易账号，不索要任何密码。
key 只由用户本人在页面「管理 AI」里填，不要发给任何人、不要贴到聊天里。

## 功能清单

- 链接即邀请：打开链接自动进群，自动分配访客名（如“访客 1234”），进群后可改名。
- 实时群聊：WebSocket，多人同时在线收发文字；消息落盘保存，刷新、重进可回看历史。
- 发图片：支持发指标截图（单张 ≤5MB），图片存服务器本地。
- AI 一起回：默认全体开启的 AI 一起回；消息开头 @某个 AI 的名字就只让它回。
- 看图说明：没勾“能看图”的 AI 收到带图消息时，会自动只按文字回，并在群里说明它看不了图片。
- 通用接入：管理界面贴任意 OpenAI 兼容 base URL + key，点「测试」自动匹配接通、拉回模型列表再选模型；成员随时加、换、移出、开关。
- 失败诚实显示：key 无效、连不上、没有开启的成员时，群里如实提示，绝不伪造 AI 回复。
- key 保护：所有接口返回的 key 一律只显示尾号（如 ••••0000），完整 key 只存在服务器数据文件里。
- 多群：链接后加 `?room=名字` 就是另一个群，历史分开。例：`http://服务器IP:3000/?room=指标讨论`

## 本地启动

```bash
cd ai-group-chat
npm install
node server.js
```

打开 http://127.0.0.1:3000/ 即可进群。
第一次进群群里还没有 AI，先点右上角「管理 AI」，贴 API 链接 + key，点「测试」拉回模型、选模型、添加到群里，就能开始聊了。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（0.0.0.0 才能从别的机器访问） |
| `DATA_DIR` | `./data` | 消息、成员、上传图片的存放目录 |

## 接口说明（简要）

- WebSocket `/ws`：客户端先发 `{type:'join', room, name}` 进群；发消息 `{type:'chat', text, imageDataUrl}`；改名 `{type:'rename', name}`。服务端推送 `init`（历史 + 成员 + 在线真人）、`message`、`presence`、`members`。
- REST：`GET /api/members`（掩码）、`POST /api/members`（添加）、`PATCH /api/members/:id`（改名/换模型/开关）、`DELETE /api/members/:id`（移出）、`POST /api/test-endpoint`（不落盘的接口测试，返回模型列表）、`POST /api/members/:id/test`（测已有成员并更新状态）。
- `test/` 目录里的模拟接口和测试脚本只用于本地验证，部署不需要。

## 本地验证结果（2026-10-27）

用模拟 OpenAI 兼容接口（`test/mock-provider.js`）+ 真实服务端跑端到端，18 项全部通过：

```bash
MOCK_PORT=3123 node test/mock-provider.js
PORT=3100 DATA_DIR=/tmp/agc-test-data node server.js
APP_URL=http://127.0.0.1:3100 MOCK_URL=http://127.0.0.1:3123 node test/ws-test.js
```

通过项：首页、进群自动访客名、改名提示、无开启成员时如实提示、添加成员、成员接口不外泄 key、测试端点拉回模型、AI 正常回复、@单个只让它回、不@全体一起回、不看图的 AI 出文字说明、能看图的 AI 收到图片并回复、坏 key 如实提示 key 无效且不伪造回复、连不上的端点如实报错、成员列表不外泄 key、重进回看历史。

注意：真实 AI 回复必须用用户自己的 key 才能验证；上面用的是模拟接口，不是真实厂商回复。

## 部署到 LA VPS（144.202.123.216）

下面步骤是在服务器上用 Termius 一条一条粘贴执行的（每段代码块就是一条命令，一次粘贴）。

**端口说明（先看）：** 本应用默认用 `3000`（TCP）。服务器上已有服务占的端口不要碰：Shadowsocks 占 `8388`，Hysteria2 占 UDP `443`，`3000` 和它们都不冲突。不要把 `PORT` 改成 `8388` 或 `443`。

**第 1 步：检查 Node（需要 v18 以上）**

```bash
node -v
```

**第 2 步：如果上一步没有 Node，安装 Node 20（Ubuntu/Debian 系统）**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
```

**第 3 步：放行端口**

```bash
sudo ufw allow 3000/tcp
```

```bash
sudo ufw status
```

如果 `ufw status` 显示 `inactive`，说明服务器没开 ufw，这一步不用管；如果放行后仍打不开页面，再去 Vultr 控制台检查云厂商防火墙有没有放行 `3000`。

**第 4 步：把代码传到服务器**

二选一：

A. 走 GitHub 公开仓库：

```bash
cd ~ && git clone https://github.com/ktm890rim-png/ai-group-chat.git ai-group-chat
```

B. 不用 git：直接把 `ai-group-chat` 整个文件夹传到服务器的 `~/ai-group-chat`。

**第 5 步：安装依赖**

```bash
cd ~/ai-group-chat && npm install
```

**第 6 步：确认 node 的路径（下一步 systemd 要用）**

```bash
which node
```

正常应显示 `/usr/bin/node`；如果显示别的路径，把下一步里的 `/usr/bin/node` 换成实际路径。

**第 7 步：写 systemd 服务（开机自启、挂了自动拉起，一次粘贴整段）**

```bash
sudo tee /etc/systemd/system/ai-group-chat.service > /dev/null <<'EOF'
[Unit]
Description=AI 群聊
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/ai-group-chat
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

注意：如果登录服务器的账号不是 root，把上面 `User=root` 和 `/root/ai-group-chat` 换成该账号和它的家目录路径。

**第 8 步：启用并启动**

```bash
sudo systemctl daemon-reload
```

```bash
sudo systemctl enable --now ai-group-chat
```

**第 9 步：检查运行状态**

```bash
sudo systemctl status ai-group-chat --no-pager
```

看到 `active (running)` 就是跑起来了。

**第 10 步：打开链接**

```
http://144.202.123.216:3000/
```

这条就是通用群链接：发给谁，谁点开就自动进群。想分话题就给链接加 `?room=名字`，例如 `http://144.202.123.216:3000/?room=指标讨论`。

**以后更新代码**

```bash
cd ~/ai-group-chat && git pull && npm install && sudo systemctl restart ai-group-chat
```

（走 B 方式传代码的，传完新文件后只执行后半段：`sudo systemctl restart ai-group-chat`）

**看日志 / 停止**

```bash
sudo journalctl -u ai-group-chat -f
```

```bash
sudo systemctl stop ai-group-chat
```

## 安全提醒

- 这个链接就是全部权限：拿到链接的人能进群说话，也能进「管理 AI」加成员、消耗 key 的额度。所以链接只发给信得过的人，不要发到公开地方。
- key 只在页面「管理 AI」里填，不要发给任何人、不要贴到聊天记录里；不用的成员随时关掉或移出。
- API 调用按量花钱，群里每次全体回复都会给每个开启的 AI 发一次请求，成员开得多、花得越快。

## 目录结构

```
ai-group-chat/
├── server.js          # 服务端：HTTP + WebSocket + OpenAI 兼容调用 + 落盘
├── package.json       # 唯一依赖：ws
├── public/
│   ├── index.html     # 群聊页面
│   ├── app.js         # 前端逻辑
│   └── style.css      # 样式（手机优先）
├── test/
│   ├── mock-provider.js  # 本地验证用模拟接口（部署不需要）
│   └── ws-test.js        # 本地端到端验证脚本（部署不需要）
└── README.md
```

运行时自动生成 `data/`（消息、成员、上传图片），已加入 `.gitignore`，不要提交。

## 常见问题

- **页面打不开**：先看 `systemctl status` 是不是 running，再看 `ufw status` 和 Vultr 防火墙有没有放行 `3000`。
- **测试时提示 key 无效**：key 贴错了或没权限，换 key 再测；页面不会伪造“已接通”。
- **测试时提示连不上**：API 链接写错了，或服务器出网到不了那个地址；先检查链接拼写。
- **模型列表拉不到但接口是通的**：有些接口没有 `/models`，页面会如实提示，手动填模型名一样能添加。
- **AI 不回话**：先看群里有没有“没有开启的 AI 成员”的提示；再去「管理 AI」里看成员开关开了没有、状态是不是失败。
