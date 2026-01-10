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
        :root { --wechat-green: #07C160; --bg-gray: #f2f2f2; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif; background-color: var(--bg-gray); display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; color: #333; }
        .card { background: white; width: 90%; max-width: 400px; padding: 32px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); text-align: center; }
        .logo { width: 64px; height: 64px; background: var(--wechat-green); border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: white; font-size: 32px; font-weight: bold; }
        h1 { font-size: 24px; margin: 0 0 8px; font-weight: 600; }
        .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
        .features { text-align: left; background: #f9f9f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; }
        .feature-item { display: flex; align-items: flex-start; margin-bottom: 12px; font-size: 14px; line-height: 1.6; }
        .feature-item:last-child { margin-bottom: 0; }
        .feature-icon { margin-right: 10px; font-size: 16px; }
        .status-box { border-top: 1px solid #eee; pt: 20px; margin-top: 10px; }
        .status-badge { display: inline-flex; align-items: center; background: rgba(7, 193, 96, 0.1); color: var(--wechat-green); padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 500; margin-bottom: 12px; }
        .status-dot { width: 8px; height: 8px; background: var(--wechat-green); border-radius: 50%; margin-right: 8px; animation: pulse 2s infinite; }
        .guide { font-size: 12px; color: #b2b2b2; line-height: 1.5; }
        @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } 100% { opacity: 1; transform: scale(1); } }
    </style>
</head>
<body>
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
                <span class="feature-icon">�</span>
                <span style="color: #07C160; font-weight: bold;">尊享特权：100%支持发送会员及付费收费歌曲</span>
            </div>
        </div>

        <div class="status-box">
            <div class="status-badge">
                <div class="status-dot"></div>
                服务在线 · 运行正常
            </div>
            <p class="guide">※ 若点歌插件无响应，可刷新此页面关注最新状态。</p>
        </div>
    </div>
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
    const { name } = request.query;

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
