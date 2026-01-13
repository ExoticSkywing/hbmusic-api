/**
 * HBMusic - 微信点歌插件后端服务
 * 
 * 基于 TuneHub API，支持网易云、QQ音乐、酷我音乐
 * 优先使用酷我音源，自动换源保证可用性
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';

// ============= 配置 =============
const CONFIG = {
    PORT: parseInt(process.env.PORT || '3000'),
    HOST: process.env.HOST || '0.0.0.0',
    TUNEHUB_BASE: process.env.TUNEHUB_BASE || 'https://music-dl.sayqz.com/api',
    BITRATE: process.env.BITRATE || '320k',
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '2'),
    // 音源优先级：酷我优先
    SOURCE_PRIORITY: (process.env.SOURCE_PRIORITY || 'kuwo,netease,qq').split(','),
};

// ============= Fastify 实例 =============
const app = Fastify({
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        transport: {
            target: 'pino-pretty',
            options: { colorize: true }
        }
    }
});

// 注册 CORS
await app.register(cors, { origin: true });

// ============= 安全防护 =============

// 敏感路径前缀（扫描器常探测的路径）
const SENSITIVE_PATHS = ['/api', '/admin', '/config', '/system', '/manage', '/backend', '/.env', '/.git', '/wp-'];

// 敏感路径拦截钩子
app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0].toLowerCase();

    // 检查是否命中敏感路径前缀
    if (SENSITIVE_PATHS.some(prefix => path.startsWith(prefix))) {
        request.log.warn({ path, ip: request.ip }, '敏感路径探测被拦截');
        return reply.code(403).send('Forbidden');
    }
});

// 统一 404 响应（不泄露技术栈信息）
app.setNotFoundHandler((request, reply) => {
    reply.code(404).send('Not Found');
});

// ============= 客户端验证 =============
// 是否启用 UA 验证（默认启用）
const UA_FILTER_ENABLED = process.env.UA_FILTER !== 'false';

// 需要验证的路由列表（主接口）
const PROTECTED_ROUTES = ['/'];

// 浏览器 UA 黑名单关键字（拒绝这些）
const BROWSER_BLACKLIST = [
    // 国际主流浏览器
    'Chrome/',
    'Firefox/',
    'Safari/',
    'Edge/',
    'Opera/',
    'MSIE',
    'Trident/',
    // 国内浏览器
    'QQBrowser/',
    'UCBrowser/',
    'MiuiBrowser/',
    '360SE',
    '360EE',
    'Baidu',
    'Sogou',
    'Quark/',
    'LBBROWSER',
    'Maxthon/',
    '2345Explorer/',
];

// UA 验证中间件
app.addHook('onRequest', async (request, reply) => {
    // 跳过非保护路由（健康检查、资源代理等）
    if (!PROTECTED_ROUTES.includes(request.url.split('?')[0])) {
        return;
    }

    // 跳过验证（如果禁用）
    if (!UA_FILTER_ENABLED) {
        return;
    }

    const ua = request.headers['user-agent'] || '';

    // 如果包含微信标识，直接放行
    if (ua.includes('MicroMessenger')) {
        return;
    }

    // 检测是否为常见浏览器（在黑名单中）
    const isBrowser = BROWSER_BLACKLIST.some(keyword => ua.includes(keyword));

    if (isBrowser) {
        request.log.warn({ ua: ua.substring(0, 100) }, '浏览器请求被拒绝');

        const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HBMusic | 服务状态</title>
    <style>
        :root { --wechat-green: #07C160; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif; 
            background: linear-gradient(135deg, #e0f7e9 0%, #f0f4f8 50%, #e8f4f8 100%);
            min-height: 100vh; 
            /* 使用 min-content 确保 body 高度能被卡片撑开 */
            height: auto;
            display: flex; 
            flex-direction: column;
            align-items: center; 
            justify-content: flex-start;
            padding: 40px 20px 100px; /* 增加底部 padding 防止遮挡波纹 */
            color: #333;
            position: relative;
            -webkit-overflow-scrolling: touch;
        }
        
        /* 动态波纹背景 - 强制固定在视口最底部 */
        .waves { 
            position: fixed; 
            bottom: 0; 
            left: 0; 
            width: 100%; 
            height: 25vh; /* 缩小高度，避免在移动端太突兀 */
            pointer-events: none; 
            z-index: 0; 
        }
        .wave { position: absolute; bottom: 0; width: 200%; height: 100%; animation: wave 10s linear infinite; opacity: 0.6; }
        .wave:nth-child(1) { background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 320'%3E%3Cpath fill='%2307C160' fill-opacity='0.3' d='M0,160L48,176C96,192,192,224,288,213.3C384,203,480,149,576,138.7C672,128,768,160,864,181.3C960,203,1056,213,1152,192C1248,171,1344,117,1392,90.7L1440,64L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z'%3E%3C/path%3E%3C/svg%3E") repeat-x; background-size: 50% 100%; animation-duration: 12s; }
        .wave:nth-child(2) { background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 320'%3E%3Cpath fill='%2307C160' fill-opacity='0.2' d='M0,64L48,80C96,96,192,128,288,128C384,128,480,96,576,106.7C672,117,768,171,864,181.3C960,192,1056,160,1152,133.3C1248,107,1344,85,1392,74.7L1440,64L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z'%3E%3C/path%3E%3C/svg%3E") repeat-x; background-size: 50% 100%; animation-duration: 8s; animation-direction: reverse; }
        .wave:nth-child(3) { background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 320'%3E%3Cpath fill='%2307C160' fill-opacity='0.15' d='M0,224L48,213.3C96,203,192,181,288,181.3C384,181,480,203,576,218.7C672,235,768,245,864,234.7C960,224,1056,192,1152,165.3C1248,139,1344,117,1392,106.7L1440,96L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z'%3E%3C/path%3E%3C/svg%3E") repeat-x; background-size: 50% 100%; animation-duration: 15s; }
        @keyframes wave { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        
        /* 深度视觉统一内容区 */
        .card { 
            background: rgba(255, 255, 255, 0.4); 
            backdrop-filter: blur(15px); 
            -webkit-backdrop-filter: blur(15px);
            width: 100%; max-width: 400px; padding: 32px; border-radius: 28px; 
            box-shadow: 0 15px 45px rgba(7, 193, 96, 0.1); 
            text-align: center; 
            position: relative; 
            z-index: 1;
            border: 1px solid rgba(255,255,255,0.6);
            margin-bottom: 20px;
        }
        .logo { width: 72px; height: 72px; background: var(--wechat-green); border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: white; font-size: 36px; font-weight: bold; box-shadow: 0 8px 25px rgba(7, 193, 96, 0.3); }
        h1 { font-size: 26px; margin: 0 0 8px; font-weight: 700; color: #1a1a1a; }
        .subtitle { color: #666; font-size: 15px; margin-bottom: 24px; }
        .features { text-align: left; background: rgba(255, 255, 255, 0.5); padding: 20px; border-radius: 16px; margin-bottom: 24px; border: 1px solid rgba(255,255,255,0.4); }
        .feature-item { display: flex; align-items: center; margin-bottom: 16px; font-size: 14px; line-height: 1.4; color: #333; }
        .feature-item:last-child { margin-bottom: 0; }
        .feature-icon { margin-right: 12px; font-size: 18px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); }
        .status-box { border-top: 1px solid rgba(0,0,0,0.05); pt: 24px; margin-top: 12px; }
        .status-badge { display: inline-flex; align-items: center; background: rgba(7, 193, 96, 0.1); color: var(--wechat-green); padding: 6px 16px; border-radius: 24px; font-size: 13px; font-weight: 600; margin-bottom: 16px; border: 1px solid rgba(7, 193, 96, 0.15); }
        .status-dot { width: 8px; height: 8px; background: var(--wechat-green); border-radius: 50%; margin-right: 8px; animation: pulse 2s infinite; }
        .guide { 
            font-size: 13px; 
            color: #7d5a00; 
            line-height: 1.6; 
            background: rgba(255, 243, 205, 0.7); 
            border: 1px solid rgba(255, 238, 186, 0.5); 
            padding: 14px; 
            border-radius: 14px; 
            margin-top: 15px;
            display: block;
            text-align: left;
        }
        .copy-btn { margin-top: 12px; background: var(--wechat-green); color: white; border: none; padding: 12px 24px; border-radius: 12px; font-size: 14px; cursor: pointer; transition: all 0.3s; font-weight: 600; width: 100%; box-shadow: 0 4px 15px rgba(7, 193, 96, 0.2); }
        .copy-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(7, 193, 96, 0.3); }
        .copy-btn:active { transform: translateY(0); }
        .url-box { margin-top: 18px; font-family: 'SF Mono', 'Roboto Mono', monospace; font-size: 12px; background: rgba(255, 255, 255, 0.6); padding: 14px; border-radius: 14px; border: 1px solid rgba(0,0,0,0.05); word-break: break-all; color: var(--wechat-green); font-weight: 600; cursor: pointer; transition: all 0.2s; }
        .url-box:hover { background: rgba(255, 255, 255, 0.8); }
        
        /* 复制成功 Toast - 趣味动画版 */
        #toast { 
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.8); 
            background: white; color: #333; padding: 30px 40px; border-radius: 16px; 
            text-align: center; display: none; z-index: 999;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            animation: popIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
        }
        #toast .checkmark {
            width: 60px; height: 60px; border-radius: 50%; display: block; 
            stroke-width: 3; stroke: white; stroke-miterlimit: 10; 
            margin: 0 auto 15px; box-shadow: inset 0px 0px 0px var(--wechat-green);
            animation: fill 0.4s ease-in-out 0.4s forwards, scale 0.3s ease-in-out 0.9s both;
        }
        #toast .checkmark-circle {
            stroke-dasharray: 166; stroke-dashoffset: 166; stroke-width: 3; 
            stroke-miterlimit: 10; stroke: var(--wechat-green); fill: none;
            animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards;
        }
        #toast .checkmark-check {
            transform-origin: 50% 50%; stroke-dasharray: 48; stroke-dashoffset: 48;
            animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.8s forwards;
        }
        #toast .success-text { font-size: 16px; font-weight: 600; color: var(--wechat-green); }
        #toast .sub-text { font-size: 12px; color: #999; margin-top: 5px; }
        
        @keyframes popIn { to { transform: translate(-50%, -50%) scale(1); } }
        @keyframes stroke { 100% { stroke-dashoffset: 0; } }
        @keyframes scale { 0%, 100% { transform: none; } 50% { transform: scale3d(1.1, 1.1, 1); } }
        @keyframes fill { 100% { box-shadow: inset 0px 0px 0px 30px var(--wechat-green); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } 100% { opacity: 1; transform: scale(1); } }
    </style>
</head>
<body>
    <!-- 动态波纹 -->
    <div class="waves">
        <div class="wave"></div>
        <div class="wave"></div>
        <div class="wave"></div>
    </div>
    
    <div class="card">
        <div class="logo">🎵</div>
        <h1>HBMusic</h1>
        <div class="subtitle">微信点歌插件专用后端服务</div>
        
        <div class="features">
            <div class="feature-item">
                <span class="feature-icon">🌐</span>
                <span><b>全平台覆盖</b>：集成网易云、QQ、酷我等高品质音源</span>
            </div>
            <div class="feature-item">
                <span class="feature-icon">🎧</span>
                <span><b>无损音质</b>：支持最高 320k/FLAC 码率智能解析</span>
            </div>
            <div class="feature-item">
                <span class="feature-icon">⚡</span>
                <span><b>快速响应</b>：0秒极速解析，让氛围燃爆全场</span>
            </div>
            <div class="feature-item">
                <span class="feature-icon">👑</span>
                <span style="color: #07C160; font-weight: bold;">尊享特权：100%支持发送会员及付费收费歌曲</span>
            </div>
        </div>

        <div class="status-box">
            <div class="status-badge">
                <div class="status-dot"></div>
                服务在线 · 运行正常
            </div>
            <div class="url-box" id="apiUrl" onclick="copyUrl()">https://hbmusic.1yo.cc/?name=</div>
            <button class="copy-btn" onclick="copyUrl()">一键复制地址</button>
            <p class="guide" id="tip"><b>⚠️ 温馨提示</b><br>若点歌插件无响应，可到浏览器访问此页面关注服务最新状态。如果页面能正常显示，说明后端运行正常。</p>
        </div>
    </div>

    <!-- Toast 弹窗 - 趣味动画版 -->
    <div id="toast">
        <svg class="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
            <circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
            <path class="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8" stroke="white" stroke-width="3"/>
        </svg>
        <div class="success-text">复制成功 🎉</div>
        <div class="sub-text">地址已复制到剪贴板</div>
    </div>

    <script>
        function copyUrl() {
            const url = document.getElementById('apiUrl').innerText;
            navigator.clipboard.writeText(url).then(() => {
                const toast = document.getElementById('toast');
                toast.style.display = 'block';
                setTimeout(() => { toast.style.display = 'none'; }, 2000);
            });
        }
    </script>

    <!-- Chatway 客服组件 -->
    <script id="chatway" async="true" src="https://cdn.chatway.app/widget.js?id=i5GVIcMxReNp"></script>
</body>
</html>`;

        return reply.code(200).type('text/html').send(html);
    }

    // 其他客户端（如 CFNetwork/Calculator 等原生 HTTP 客户端）放行
});

// ============= 路由 =============

// 健康检查
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// 主接口：搜索歌曲
app.get('/', async (request, reply) => {
    // 增加对 'hame' 的容错处理，防止傻逼打错字
    const name = request.query.name || request.query.hame;

    if (!name) {
        return reply.code(400).send({
            code: 400,
            message: '缺少 name 参数，请使用 ?name=歌曲名 格式请求'
        });
    }

    try {
        const result = await searchAndGetSongInfo(name, request.log);
        return result;
    } catch (error) {
        request.log.error(error, '搜索歌曲失败');
        return reply.code(500).send({
            code: 500,
            message: '服务内部错误: ' + error.message
        });
    }
});

// 音频流代理（隐藏 TuneHub）
app.get('/stream', async (request, reply) => {
    const { source, id, br } = request.query;

    if (!source || !id) {
        return reply.code(400).send({ error: '缺少 source 或 id 参数' });
    }

    const bitrate = br || CONFIG.BITRATE;
    const targetUrl = `${CONFIG.TUNEHUB_BASE}?source=${source}&id=${id}&type=url&br=${bitrate}`;

    try {
        // 第一步：获取重定向后的真实 URL
        const redirectRes = await fetch(targetUrl, { redirect: 'manual' });
        let finalUrl = targetUrl;

        if (redirectRes.status === 301 || redirectRes.status === 302) {
            finalUrl = redirectRes.headers.get('location') || targetUrl;
        }

        // 第二步：请求真实音频并转发
        const headers = {};
        if (request.headers.range) {
            headers['Range'] = request.headers.range;
        }
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

        // 对网易云添加 Referer
        if (source === 'netease') {
            headers['Referer'] = 'https://music.163.com/';
        }

        const audioRes = await fetch(finalUrl, { headers });

        // 设置响应头
        reply.header('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
        reply.header('Accept-Ranges', 'bytes');

        if (audioRes.headers.get('content-length')) {
            reply.header('Content-Length', audioRes.headers.get('content-length'));
        }
        if (audioRes.headers.get('content-range')) {
            reply.header('Content-Range', audioRes.headers.get('content-range'));
        }

        reply.code(audioRes.status);
        return reply.send(audioRes.body);

    } catch (error) {
        request.log.error(error, '音频代理失败');
        return reply.code(502).send({ error: '音频获取失败' });
    }
});

// 封面代理
app.get('/cover', async (request, reply) => {
    const { source, id } = request.query;

    if (!source || !id) {
        return reply.code(400).send({ error: '缺少参数' });
    }

    const targetUrl = `${CONFIG.TUNEHUB_BASE}?source=${source}&id=${id}&type=pic`;

    try {
        const res = await fetch(targetUrl, { redirect: 'follow' });
        reply.header('Content-Type', res.headers.get('content-type') || 'image/jpeg');
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.send(res.body);
    } catch (error) {
        return reply.code(502).send({ error: '封面获取失败' });
    }
});

// 歌词代理
app.get('/lyric', async (request, reply) => {
    const { source, id } = request.query;

    if (!source || !id) {
        return reply.code(400).send({ error: '缺少参数' });
    }

    const targetUrl = `${CONFIG.TUNEHUB_BASE}?source=${source}&id=${id}&type=lrc`;

    try {
        const res = await fetch(targetUrl, { redirect: 'follow' });
        const lrcText = await res.text();
        reply.header('Content-Type', 'text/plain; charset=utf-8');
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.send(lrcText);
    } catch (error) {
        return reply.code(502).send({ error: '歌词获取失败' });
    }
});

// ============= 核心逻辑 =============

/**
 * 搜索歌曲并获取完整信息
 */
async function searchAndGetSongInfo(keyword, log) {
    for (const source of CONFIG.SOURCE_PRIORITY) {
        try {
            const result = await tryGetSongFromSource(keyword, source, log);
            if (result) {
                log.info({ source, title: result.title }, '获取歌曲成功');
                return result;
            }
        } catch (error) {
            log.warn({ source, error: error.message }, '音源搜索失败，尝试下一个');
            continue;
        }
    }

    return { code: 404, message: `未找到歌曲: ${keyword}` };
}

/**
 * 从指定音源获取歌曲
 */
async function tryGetSongFromSource(keyword, source, log) {
    // Step 1: 搜索
    const searchUrl = `${CONFIG.TUNEHUB_BASE}?type=search&source=${source}&keyword=${encodeURIComponent(keyword)}&limit=1`;
    const searchRes = await fetchWithRetry(searchUrl);

    if (!searchRes.ok) throw new Error(`搜索失败: ${searchRes.status}`);

    const searchData = await searchRes.json();
    if (searchData.code !== 200 || !searchData.data?.results?.length) {
        return null;
    }

    const song = searchData.data.results[0];
    const songId = song.id;

    // Step 2: 获取详情
    const infoUrl = `${CONFIG.TUNEHUB_BASE}?type=info&source=${source}&id=${songId}&br=${CONFIG.BITRATE}`;
    const infoRes = await fetchWithRetry(infoUrl);

    if (!infoRes.ok) throw new Error(`详情失败: ${infoRes.status}`);

    const infoData = await infoRes.json();
    if (infoData.code !== 200 || !infoData.data) {
        throw new Error('获取详情失败');
    }

    const info = infoData.data;

    // 构建代理 URL（隐藏 TuneHub）
    const baseUrl = process.env.BASE_URL || `http://localhost:${CONFIG.PORT}`;

    return {
        code: 200,
        title: info.name || song.name,
        singer: info.artist || song.artist || '未知歌手',
        cover: `${baseUrl}/cover?source=${source}&id=${songId}`,
        link: getDetailPageLink(source, songId),
        music_url: `${baseUrl}/stream?source=${source}&id=${songId}&br=${CONFIG.BITRATE}`,
        lyric: `${baseUrl}/lyric?source=${source}&id=${songId}`,
        source
    };
}

/**
 * 生成详情页链接
 */
function getDetailPageLink(source, id) {
    const links = {
        kuwo: `https://www.kuwo.cn/play_detail/${id}`,
        netease: `https://music.163.com/#/song?id=${id}`,
        qq: `https://y.qq.com/n/ryqq/songDetail/${id}`
    };
    return links[source] || '';
}

/**
 * 带重试的 fetch
 */
async function fetchWithRetry(url, options = {}) {
    let lastError;

    for (let i = 0; i <= CONFIG.MAX_RETRIES; i++) {
        try {
            const res = await fetch(url, {
                ...options,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    ...options.headers
                }
            });

            if (res.status >= 500) throw new Error(`Server Error: ${res.status}`);
            return res;
        } catch (error) {
            lastError = error;
            if (i < CONFIG.MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 200 * (i + 1)));
            }
        }
    }

    throw lastError;
}

// ============= 启动服务 =============
try {
    await app.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
    console.log(`
╔═══════════════════════════════════════════════════╗
║          🎵 HBMusic 点歌服务已启动                ║
╠═══════════════════════════════════════════════════╣
║  地址: http://${CONFIG.HOST}:${CONFIG.PORT}
║  音源: ${CONFIG.SOURCE_PRIORITY.join(' > ')}
║  音质: ${CONFIG.BITRATE}
╚═══════════════════════════════════════════════════╝
  `);
} catch (err) {
    app.log.error(err);
    process.exit(1);
}
