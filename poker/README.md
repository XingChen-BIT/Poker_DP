# 德州扑克 · 多人实时对战

一个支持 2~10 人实时对战的 Web 版德州扑克。玩家各自用手机或电脑进入同一房间，即可体验完整的下注、弃牌、亮牌与筹码结算流程。

## 功能

- 房主创建房间，生成 6 位房间码 / 邀请链接，好友凭码加入
- 2~10 人同桌；房主开局前可设置初始筹码、小盲/大盲
- 标准流程：翻牌前 → 翻牌 → 转牌 → 河牌，自动盲注，顺时针行动
- 操作齐全：弃牌 / 过牌 / 跟注 / 加注（滑块 + 快捷额度）/ 全下
- 实时显示底池、每位玩家剩余筹码、当前轮到谁（高亮）
- 标准牌型判定（皇家同花顺 > 同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌），支持多人平分底池与**边池（side pot）**结算
- 河牌后所有未弃牌玩家亮牌，界面展示牌型名称与胜负
- 每局结束可「下一局」，筹码保留、庄家与盲注自动轮换；淘汰玩家自动坐观
- 响应式布局，手机 / 电脑自适应；轮到自己有提示音；断线自动托管（能过牌则过牌，否则弃牌）

## 技术栈

Node.js + Express + Socket.io，前端为原生 HTML/CSS/JS（无构建步骤），部署即用。

## 本地运行

需要 Node.js 18 及以上。

```bash
cd poker
npm install
npm start
# 打开 http://localhost:3000
```

同一台电脑可开多个浏览器窗口（或不同设备连同一局域网，访问 `http://你的局域网IP:3000`）即可多人同桌测试。

运行测试：

```bash
npm test
```

## 部署到免费云平台（公网可玩）

任选其一，部署后拿到公网链接，把链接发给好友即可在线对战。

### 方式一：Render（最简单）

1. 把本项目推送到 GitHub 仓库
2. 打开 [render.com](https://render.com)，注册登录后 **New → Blueprint**，选择该仓库
3. Render 会自动读取仓库里的 `render.yaml`，点 **Apply** 即可
4. 部署完成后，用生成的 `https://xxx.onrender.com` 链接开玩

> 提示：Render 免费实例闲置约 15 分钟会休眠，首次访问需等几十秒唤醒。

### 方式二：Railway

1. 推送仓库到 GitHub
2. 打开 [railway.app](https://railway.app)，**New Project → Deploy from GitHub repo** 选择该仓库
3. Railway 自动识别（已提供 `railway.json`），部署即可获得公网域名

### 方式三：Fly.io

1. 安装 [flyctl](https://fly.io/docs/flyctl/) 并登录：`fly auth login`
2. 在项目目录执行 `fly launch`（会读取 `Dockerfile` 与 `fly.toml`）
3. 部署完成：`fly deploy`，用分配的 `https://xxx.fly.dev` 开玩

### 方式四：任意支持 Docker 的平台

项目自带 `Dockerfile`，`docker build -t poker-room . && docker run -p 3000:3000 poker-room` 即可，也可直接部署到任何支持容器的平台。

## 注意事项

- 房间与对局状态保存在服务器内存中，服务重启或 Render 免费实例休眠重建后，进行中的房间会失效（已部署到公网后一般无碍，注意提醒好友开局）。
- 每位玩家行动限时 40 秒，超时自动托管；掉线的玩家座位保留，重新打开页面可凭本地会话自动回到房间。
- 本小局结算与自动开局统一为最多 15 秒，不再额外保留看牌阶段。所有在线参与玩家点击“进入下一局”后会立即发下一手；掉线玩家不计入确认名单。
- 牌桌右上角的 `i` 可打开规则说明、牌型大小和常用德扑术语中英文对照表。

## 调整倒计时

所有可调时间集中在 `server.js` 顶部的“时间配置”区域：

- `TURN_TIMEOUT_MS`：单次行动时间，当前为 `40000`（40 秒）。
- `NEXT_HAND_FOLD_MS` / `NEXT_HAND_SHOWDOWN_MS`：无人全员确认时的本小局最长结算时间，当前为 `15000`（15 秒），与弹窗同步。
- `SETTLEMENT_MODAL_MS`：结算弹窗倒计时，当前为 `15000`（15 秒）。

修改后重新启动服务即可。前端进度条会读取服务端下发的总时长和截止时间，不需要同步修改 CSS 或 JavaScript。

## 目录结构

```
poker/
├── server.js            # Express + Socket.io 服务端、房间管理、回合计时
├── engine/
│   ├── cards.js         # 牌组、洗牌、花色/点数
│   ├── evaluate.js      # 7 选 5 最优牌型判定、比牌、中文牌型描述
│   └── table.js         # 牌桌状态机：盲注、四轮下注、边池、结算、庄家轮换
├── public/
│   ├── index.html       # 入口 / 大厅 / 牌桌
│   ├── style.css        # 响应式牌桌 UI
│   └── app.js           # 客户端逻辑与交互
├── test/engine.test.js  # 牌型 + 边池单元测试
├── Dockerfile / render.yaml / railway.json / fly.toml
└── package.json
```
