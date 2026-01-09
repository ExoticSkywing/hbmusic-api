# 🎵 HBMusic - 微信点歌插件后端服务

自部署的点歌服务，支持网易云、QQ音乐、酷我三大平台。

## ✨ 特性

- **三平台聚合**：酷我 > 网易云 > QQ，自动换源
- **VIP 可用**：部分平台付费歌曲也能解析
- **Docker 部署**：一键启动，零配置

## 🚀 快速部署

### 1. 修改配置

编辑 `docker-compose.yml`，修改 `BASE_URL` 为你的实际域名：

```yaml
- BASE_URL=https://music.yourdomain.com
```

### 2. 启动服务

```bash
docker-compose up -d
```

### 3. 配置反向代理

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name music.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 4. 微信插件配置

在插件的"自定义服务接口"填入：

```
https://music.yourdomain.com/?name=
```

## 📖 API 说明

### 搜索歌曲

```
GET /?name=晴天
```

响应：
```json
{
  "code": 200,
  "title": "晴天",
  "singer": "周杰伦",
  "cover": "https://music.yourdomain.com/cover?id=xxx",
  "link": "https://www.kuwo.cn/play_detail/xxx",
  "music_url": "https://music.yourdomain.com/stream?id=xxx"
}
```

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|:---|:---|:---|
| `PORT` | 3000 | 服务端口 |
| `BASE_URL` | - | **必填**，你的服务域名 |
| `BITRATE` | 320k | 音质：128k / 320k / flac |
| `SOURCE_PRIORITY` | kuwo,netease,qq | 音源优先级 |

## 📝 License

MIT
