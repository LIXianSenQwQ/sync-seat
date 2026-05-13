# Sync Seat

轻量级同步观影房间，面向已经通过 AList 或 OpenList 挂载网盘资源的用户。项目目标是把“选片、建房、同步播放、语音交流、房主本地推流”做成一个可单机部署的小应用，而不是媒体库、账号系统或转码平台。

## 当前能力

- 创建临时房间，房间码加入，最多 3 人在线观影。
- 创建房间时选择观影模式：`direct` 直链同步模式或 `host-stream` 房主推流模式。
- 直链同步模式支持浏览白名单网盘目录、选择视频、选择同目录字幕、同步播放/暂停/拖动/倍速。
- 直链视频由后端校验房间当前视频后代理读取，并透传 Range 相关响应头，支持浏览器拖动进度和分片加载。
- 字幕支持同目录手动选择 `.vtt` 和 `.srt`；后端统一输出 WebVTT。
- 房间级倍速支持 `1x`、`1.25x`、`1.5x`、`2x`，所有成员都可以调整并同步到全房间。
- 播放时间以服务端 `PlaybackState` 为权威：小偏差不抖动，2 秒内用临时倍速追赶，超过 2 秒直接校准，暂停时强制同步时间。
- 房主推流模式支持房主选择本地视频，通过 WebRTC P2P mesh 推给观众；文件不上传后端。
- 语音使用 WebRTC P2P mesh，支持加入、退出、静音和本地总音量。
- 房主推流和语音可配置 STUN/TURN，并提供 ICE 路径诊断提示。
- 后端使用内存保存房间状态，适合单机部署和临时房间。

## 技术栈

- Monorepo：npm workspaces
- 前端：Vue 3、Vite、Vue Router、Socket.IO Client
- 后端：NestJS、Socket.IO Gateway、TypeScript
- 共享类型：`@sync-seat/shared`
- 媒体播放：浏览器原生 HTML5 video
- 实时同步：WebSocket
- 语音/推流：WebRTC P2P mesh
- 部署：Docker、Nginx、可选 acme.sh、可选 coturn

## 目录结构

```text
apps/
  server/        NestJS 后端、REST API、WebSocket、AList/OpenList 访问、视频/字幕输出
  web/           Vue 前端、房间页面、播放器同步、WebRTC 客户端逻辑
packages/
  shared/        前后端共享类型、事件结构、固定倍速常量
docs/            PRD 和方案文档
```

## 工作模式

### 直链同步模式

直链同步模式适合所有成员都能访问部署服务的场景。

1. 用户通过后端浏览 AList/OpenList 白名单目录。
2. 成员选择视频后，后端记录房间当前视频并广播房间状态。
3. 浏览器播放 `/api/rooms/:roomCode/video`。
4. 后端校验当前房间视频后向 AList/OpenList 打开文件流，并把内容代理给浏览器。
5. 播放、暂停、拖动、倍速变化通过 WebSocket 更新服务端权威状态。
6. 其他成员收到新版本状态后校准本地播放器。

时间同步规则：

- 服务端保存 `playing`、`positionSeconds`、`playbackRate`、`stateUpdatedAt`、`version`。
- 播放中目标时间为 `positionSeconds + elapsed * playbackRate`。
- 偏差小于 0.5 秒时不处理，避免画面抖动。
- 偏差 0.5 到 2 秒且正在播放时，用基础倍速乘 `1.05` 或 `0.95` 临时追赶。
- 偏差超过 2 秒时直接跳转到目标时间。
- 收到暂停状态时，所有客户端暂停并强制对齐到服务端暂停位置。

### 房主推流模式

房主推流模式适合房主想播放本地文件、观众不直接接触原始文件的场景。

1. 房主创建 `host-stream` 房间。
2. 房主在浏览器选择本地视频文件。
3. 前端通过 `captureStream` 从本地 video 采集媒体流。
4. 后端只转发 WebRTC offer、answer、ICE candidate，不接收、不保存、不转发视频文件。
5. 观众通过 WebRTC 接收房主媒体流。

房主推流会按 IPv6 直连、IPv4 STUN 打洞、TURN 中继的路径逐步尝试。复杂 NAT、公司网络或运营商限制环境下，建议配置 TURN。

## 环境变量

复制 `.env.example` 为 `.env` 后按实际环境修改：

```powershell
Copy-Item .env.example .env
```

核心配置：

- `ALIST_BASE_URL`：AList/OpenList 服务地址。
- `ALIST_USERNAME`：AList/OpenList 用户名。
- `ALIST_PASSWORD`：AList/OpenList 密码。
- `ALLOWED_ROOT_PATHS`：允许浏览和播放的网盘根目录，多个目录用英文逗号分隔。
- `SERVER_PORT`：后端监听端口，默认 `3000`。
- `WEB_ORIGIN`：前端访问源；开发默认 `http://localhost:5173`，生产同源部署时写实际 HTTPS 域名。
- `WEB_DIST_PATH`：生产环境前端构建产物目录，Docker 镜像默认 `/app/apps/web/dist`。

WebRTC 配置：

- `WEBRTC_STUN_URLS`：STUN 地址，多个用英文逗号分隔；默认 `stun:stun.l.google.com:19302`。
- `WEBRTC_TURN_URLS`：TURN 地址，多个用英文逗号分隔。
- `WEBRTC_TURN_USERNAME`：TURN 用户名。
- `WEBRTC_TURN_PASSWORD`：TURN 密码。

Docker Compose 示例还包含证书和 TURN 相关变量：

- `SYNC_SEAT_IMAGE`
- `TARGET_DOMAIN`
- `TURN_EXTERNAL_IP`
- `TURN_PORT`
- `TURN_REALM`
- `Ali_Key`
- `Ali_Secret`

这些值在真实部署时应只写入服务器本机 `.env` 或部署配置，不要提交真实凭据。

## 本地开发

要求 Node.js `>=20.11.0`。

安装依赖：

```powershell
npm install
```

构建共享包：

```powershell
npm run build -w @sync-seat/shared
```

启动后端：

```powershell
npm run dev -w @sync-seat/server
```

启动前端：

```powershell
npm run dev -w @sync-seat/web
```

默认访问：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`
- Vite 会代理 `/api` 和 `/socket.io` 到后端。

## 构建与测试

完整构建：

```powershell
npm run build
```

服务端测试：

```powershell
npm run test -w @sync-seat/server
```

前端测试：

```powershell
npx vitest run --config apps/web/vitest.config.ts
```

Lint：

```powershell
npm run lint
```

## Docker 部署

构建镜像：

```powershell
docker build -t sync-seat:latest .
```

运行应用容器时至少需要提供 AList/OpenList 和 CORS 配置：

```powershell
docker run --rm -p 3000:3000 `
  -e SERVER_PORT=3000 `
  -e WEB_ORIGIN=https://sync-seat.example.com `
  -e ALIST_BASE_URL=https://alist.example.com `
  -e ALIST_USERNAME=admin `
  -e ALIST_PASSWORD=replace-with-password `
  -e ALLOWED_ROOT_PATHS=/Movies,/Shows `
  sync-seat:latest
```

仓库内 `docker-compose.yml` 提供了一个生产部署模板：

- `app`：运行 Sync Seat，Nest 同时托管 Vue 构建产物。
- `nginx`：反向代理 HTTPS、API、Socket.IO、视频 Range 请求。
- `acme`：通过 DNS-01 签发和续期证书。
- `turn`：coturn 中继服务，供复杂网络下 WebRTC 使用。

使用前需要替换域名、镜像名、AList/OpenList 凭据、DNS 凭据、TURN 外网 IP 和密码。

## 关键接口

REST：

- `POST /api/rooms`：创建房间。
- `POST /api/rooms/:roomCode/join`：加入房间。
- `GET /api/rooms/:roomCode`：查询房间状态。
- `GET /api/rooms/:roomCode/video`：读取当前房间视频内容，支持 Range。
- `GET /api/rooms/:roomCode/subtitle.vtt`：读取当前字幕 WebVTT。
- `GET /api/drive/list?path=/...`：浏览网盘目录。
- `GET /api/drive/subtitles?videoPath=/...`：列出视频同目录字幕。
- `GET /api/drive/ice-servers`：获取 WebRTC ICE 配置。
- `GET /api/drive/whoami`：获取服务端识别到的客户端 IP。

WebSocket：

- `load_video`：加载或更换当前视频。
- `select_subtitle`：选择或清除字幕。
- `play`、`pause`、`seek`、`playback_rate_change`：更新直链模式播放状态。
- `voice_join`、`voice_leave`、`voice_mute`：语音状态。
- `voice_offer`、`voice_answer`、`voice_ice_candidate`：语音 WebRTC 信令。
- `host_stream_start`、`host_stream_stop`：房主推流状态。
- `host_stream_offer`、`host_stream_answer`、`host_stream_ice_candidate`：房主推流 WebRTC 信令。
- `host_control_request`：观众请求房主执行推流播放控制。

## 安全与限制

- 当前没有账号系统，房间身份保存在浏览器本地身份中。
- 房间状态保存在后端内存中，重启后会丢失。
- 当前设计面向单实例部署，不支持多实例共享房间状态。
- 房间最多 3 人，语音和房主推流均采用 P2P mesh。
- 不做媒体库、刮削、收藏、历史记录、播放列表、聊天。
- 不做视频转码；浏览器必须能播放当前视频格式。
- 直链模式会由后端代理当前视频内容，但不会隐藏部署者对 AList/OpenList 的整体访问能力边界；请务必配置 `ALLOWED_ROOT_PATHS`。
- 麦克风和部分 WebRTC 能力在公网环境通常要求 HTTPS；本地开发可使用 `localhost`。
- TURN 服务不会经过 Nginx，宿主机需要放行 TURN 端口和 UDP relay 端口段。

## 常见问题

### 看不到网盘目录

检查 `ALIST_BASE_URL`、`ALIST_USERNAME`、`ALIST_PASSWORD` 是否正确，并确认 `ALLOWED_ROOT_PATHS` 覆盖了要浏览的目录。

### 视频无法拖动或播放卡住

确认 AList/OpenList 上游支持 Range 请求，并检查 `/api/rooms/:roomCode/video` 的响应状态、`content-range` 和 `accept-ranges`。

### 语音没有声音

确认浏览器已授权麦克风，公网部署使用 HTTPS，并检查双方是否成功加入语音。

### 房主推流连接失败

先看页面里的 ICE 诊断提示。如果 IPv4 STUN 打洞失败或双方网络复杂，请配置 TURN，并放行 `3478/tcp`、`3478/udp` 以及 coturn relay UDP 端口段。
