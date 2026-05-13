# Sync Seat

轻量网盘资源同步观影房间，面向已经通过 AList/OpenList 挂载网盘资源的用户。

## 技术栈

- 前端：Vue 3 + Vite
- 后端：NestJS + TypeScript
- 实时同步：Socket.IO WebSocket
- 语音：WebRTC P2P mesh
- 存储：后端内存 Map

## 本地启动

1. 安装依赖：

   ```powershell
   npm install
   ```

2. 复制环境变量：

   ```powershell
   Copy-Item .env.example .env
   ```

3. 修改 `.env`：

   - `ALIST_BASE_URL`
   - `ALIST_USERNAME`
   - `ALIST_PASSWORD`
   - `ALLOWED_ROOT_PATHS`
   - 可选 `WEBRTC_TURN_*`

4. 启动开发服务：

   ```powershell
   npm run dev -w @sync-seat/server
   npm run dev -w @sync-seat/web
   ```

## 验证

```powershell
npm run test -w @sync-seat/server
npm run build
```

当前 v1 不做账号系统、聊天、播放列表、历史记录、视频流代理、转码、多实例部署和 SFU 语音。直链同步模式下，房间播放地址由后端校验后 302 跳转到 AList/OpenList 真实地址。
