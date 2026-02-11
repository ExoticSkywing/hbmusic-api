/**
 * HBMusic - 微信点歌插件后端服务
 * 
 * 多上游架构：支持降级兜底
 * - 主上游: qqmusicapi.1yo.cc (Cloudflare Workers)
 * - 备用上游: qq-music-api-v2 (本地服务)
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';

// ============= 配置 =============
const CONFIG = {
    PORT: parseInt(process.env.PORT || '3000'),
    HOST: process.env.HOST || '0.0.0.0',
    BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
    // 最大重试次数
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '2'),
    // 上游请求超时（毫秒）- Lucky API 响应较慢，需要较长超时
    UPSTREAM_TIMEOUT: parseInt(process.env.UPSTREAM_TIMEOUT || '15000'),
    // 公告开关（true 显示，false 隐藏）
    SHOW_ANNOUNCEMENT: process.env.SHOW_ANNOUNCEMENT === 'true',
    // 公告内容（可自定义）
    ANNOUNCEMENT_TEXT: process.env.ANNOUNCEMENT_TEXT || '系统升级中 · 正在为您打造更稳定、更优质的点歌体验，近期服务可能有波动，敬请谅解',
};

// ============= 多上游配置 =============
// 按优先级排序，依次尝试
const UPSTREAMS = [
    // 主上游：Lucky API - 直接返回真实播放链接，无需代理
    {
        name: 'lucky',
        type: 'lucky',
        url: process.env.LUCKY_API || 'https://cer.luckying.love/music/Lucky.php',
    },
    // 兜底上游：本地 QQ 音乐服务
    {
        name: 'qq-music-api-v2',
        type: 'qqmusic',
        url: process.env.QQMUSIC_FALLBACK || 'http://qq-music-api-v2:18200',
        endpoints: {
            search: '/api/search',
            url: '/api/song/url',
            lyric: '/api/lyric',
        }
    },
];

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
const SENSITIVE_PATHS = ['/admin', '/config', '/system', '/manage', '/backend', '/.env', '/.git', '/wp-'];

app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0].toLowerCase();
    if (SENSITIVE_PATHS.some(prefix => path.startsWith(prefix))) {
        request.log.warn({ path, ip: request.ip }, '敏感路径探测被拦截');
        return reply.code(403).send('Forbidden');
    }
});

app.setNotFoundHandler((request, reply) => {
    reply.code(404).send('Not Found');
});

// ============= 客户端验证 =============
const UA_FILTER_ENABLED = process.env.UA_FILTER !== 'false';
const PROTECTED_ROUTES = ['/'];

const BROWSER_BLACKLIST = [
    'Chrome/', 'Firefox/', 'Safari/', 'Edge/', 'Opera/', 'MSIE', 'Trident/',
    'QQBrowser/', 'UCBrowser/', 'MiuiBrowser/', '360SE', '360EE', 'Baidu',
    'Sogou', 'Quark/', 'LBBROWSER', 'Maxthon/', '2345Explorer/', 'HuaweiBrowser/'
];

// ============= 服务健康自检 =============
let cachedHealthStatus = { status: 'ok', text: '服务在线 · 运行正常', color: '#07C160', lastCheck: 0 };
const HEALTH_CHECK_INTERVAL = 60000;

async function checkServiceHealth() {
    const now = Date.now();
    if (now - cachedHealthStatus.lastCheck < HEALTH_CHECK_INTERVAL) {
        return cachedHealthStatus;
    }

    // 依次检查各上游
    let anyOnline = false;
    for (const upstream of UPSTREAMS) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            // 根据上游类型使用对应的检测端点
            let checkUrl;
            if (upstream.type === 'lucky') {
                checkUrl = `${upstream.url}?Love=test`;
            } else {
                checkUrl = `${upstream.url}/api/search?keyword=test&num=1`;
            }

            const res = await fetch(checkUrl, {
                signal: controller.signal,
                headers: { 'User-Agent': 'HBMusic-HealthCheck/1.0' }
            });
            clearTimeout(timeout);

            if (res.ok) {
                anyOnline = true;
                break;
            }
        } catch (e) {
            // 继续尝试下一个上游
        }
    }

    if (anyOnline) {
        cachedHealthStatus = { status: 'ok', text: '服务在线 · A1', color: '#07C160', lastCheck: now };
    } else {
        cachedHealthStatus = { status: 'error', text: '服务维护中 · B2', color: '#FF3B30', lastCheck: now };
    }

    return cachedHealthStatus;
}

// UA 验证中间件
app.addHook('onRequest', async (request, reply) => {
    if (!PROTECTED_ROUTES.includes(request.url.split('?')[0])) return;
    if (!UA_FILTER_ENABLED) return;

    const ua = request.headers['user-agent'] || '';
    if (ua.includes('MicroMessenger')) return;

    const isBrowser = BROWSER_BLACKLIST.some(keyword => ua.includes(keyword));

    if (isBrowser) {
        request.log.warn({ ua: ua.substring(0, 100) }, '浏览器请求被拒绝');
        const health = await checkServiceHealth();
        const html = getStatusPageHTML(health);
        return reply.code(200).type('text/html').send(html);
    }
});

// ============= 路由 =============

// 健康检查
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// 主接口：搜索歌曲
app.get('/', async (request, reply) => {
    const name = request.query.name || request.query.hame;

    if (!name) {
        return reply.code(400).send({
            code: 400,
            message: '缺少 name 参数，请使用 ?name=歌曲名 格式请求'
        });
    }

    try {
        const result = await searchAndGetSong(name, request.log);
        return result;
    } catch (error) {
        request.log.error(error, '搜索歌曲失败');
        return reply.code(500).send({
            code: 500,
            message: '服务内部错误: ' + error.message
        });
    }
});

// 兼容 API 路径
app.get('/api/music/url', async (request, reply) => {
    const { name, singer } = request.query;
    if (!name) return reply.code(400).send({ code: 400, message: '缺少 name 参数' });

    const keyword = singer ? `${name} ${singer}` : name;
    try {
        return await searchAndGetSong(keyword, request.log);
    } catch (error) {
        request.log.error(error, '搜索歌曲失败');
        return reply.code(500).send({ code: 500, message: error.message });
    }
});

// 音频流代理（支持 QQ 音乐 mid、酷我 rid、以及旧版 id 参数）
app.get('/fallback-stream', async (request, reply) => {
    const { mid, rid, id } = request.query;

    if (!mid && !rid && !id) {
        return reply.code(400).send({ error: '缺少 mid、rid 或 id 参数' });
    }

    // 如果只传了 id（旧格式），尝试通过 qq-music-api-v2 按 songid 获取
    if (!mid && !rid && id) {
        for (const upstream of UPSTREAMS.filter(u => u.type === 'qqmusic')) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT);

                const urlRes = await fetch(`${upstream.url}${upstream.endpoints.url}?id=${id}`, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'HBMusic/1.0' }
                });
                clearTimeout(timeout);

                const urlData = await urlRes.json();
                // 尝试从返回数据中提取播放链接
                const audioUrl = urlData.data?.[Object.keys(urlData.data || {})[0]];

                if (audioUrl) {
                    request.log.info({ source: 'qqmusic', id }, '通过 songid 获取播放链接成功');
                    // 302 重定向到真实播放链接
                    return reply.redirect(audioUrl);
                }
            } catch (e) {
                request.log.warn({ source: 'qqmusic', id, error: e.message }, '通过 songid 获取链接失败');
            }
        }

        // 所有上游都失败，返回 404（非 400，防止客户端死循环重试）
        return reply.code(404).send({ error: '该歌曲链接已过期，请重新点歌' });
    }

    let audioUrl = null;

    // 如果是酷我 rid，直接从酷我获取
    if (rid) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT);

            const kuwoUrl = `https://kw-api.cenguigui.cn?id=${rid}&type=song&level=exhigh&format=mp3`;
            const res = await fetch(kuwoUrl, {
                signal: controller.signal,
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            clearTimeout(timeout);

            // 酷我返回 302 重定向到真实链接
            if (res.ok || res.redirected) {
                audioUrl = res.url;
                request.log.info({ source: 'kuwo', rid }, '获取酷我播放链接成功');
            }
        } catch (e) {
            request.log.warn({ source: 'kuwo', error: e.message }, '酷我获取链接失败');
        }
    }

    // 如果是 QQ 音乐 mid，从 QQ 音乐上游获取
    if (!audioUrl && mid) {
        for (const upstream of UPSTREAMS.filter(u => u.type === 'qqmusic')) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT);

                const urlRes = await fetch(`${upstream.url}${upstream.endpoints.url}?mid=${mid}`, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'HBMusic/1.0' }
                });
                clearTimeout(timeout);

                const urlData = await urlRes.json();
                audioUrl = urlData.data?.[mid];

                if (audioUrl) {
                    request.log.info({ upstream: upstream.name, mid }, '获取播放链接成功');
                    break;
                }
            } catch (e) {
                request.log.warn({ upstream: upstream.name, error: e.message }, '上游获取链接失败');
            }
        }
    }

    if (!audioUrl) {
        return reply.code(404).send({ error: '无法获取播放链接' });
    }

    try {
        const audioRes = await fetch(audioUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://y.qq.com/' }
        });

        reply.header('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
        reply.header('Accept-Ranges', 'bytes');
        if (audioRes.headers.get('content-length')) {
            reply.header('Content-Length', audioRes.headers.get('content-length'));
        }
        return reply.send(audioRes.body);
    } catch (error) {
        request.log.error(error, '音频代理失败');
        return reply.code(502).send({ error: '音频获取失败' });
    }
});

// 歌词代理（支持 QQ 音乐 mid 和 酷我 rid）
app.get('/fallback-lyric', async (request, reply) => {
    const { mid, rid } = request.query;

    if (!mid && !rid) {
        return reply.code(400).send({ error: '缺少 mid 或 rid 参数' });
    }

    // 如果是酷我 rid，直接从酷我获取
    if (rid) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT);

            const kuwoUrl = `https://kw-api.cenguigui.cn?id=${rid}&type=lyr&format=all`;
            const res = await fetch(kuwoUrl, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            clearTimeout(timeout);

            const text = await res.text();
            if (text) {
                reply.header('Content-Type', 'text/plain; charset=utf-8');
                reply.header('Cache-Control', 'public, max-age=86400');
                return reply.send(text);
            }
        } catch (e) {
            request.log.warn({ source: 'kuwo', error: e.message }, '酷我获取歌词失败');
        }
    }

    // 如果是 QQ 音乐 mid，从 QQ 音乐上游获取
    if (mid) {
        for (const upstream of UPSTREAMS.filter(u => u.type === 'qqmusic')) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT);

                const res = await fetch(`${upstream.url}${upstream.endpoints.lyric}?mid=${mid}`, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'HBMusic/1.0' }
                });
                clearTimeout(timeout);

                const data = await res.json();

                if (data.code === 0 && data.data?.lyric) {
                    reply.header('Content-Type', 'text/plain; charset=utf-8');
                    reply.header('Cache-Control', 'public, max-age=86400');
                    return reply.send(data.data.lyric);
                }
            } catch (e) {
                request.log.warn({ upstream: upstream.name, error: e.message }, '上游获取歌词失败');
            }
        }
    }

    return reply.code(404).send({ error: '未找到歌词' });
});

// ============= 核心逻辑 =============

// ============= 搜索结果内存缓存 =============
// 纯内存缓存，不占磁盘空间，容器重启后自动清空
const searchCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;   // 缓存有效期：1 小时
const CACHE_MAX_SIZE = 200;         // 最大缓存条目数

function getCacheKey(keyword) {
    return keyword.trim().toLowerCase();
}

function getFromCache(keyword) {
    const key = getCacheKey(keyword);
    const entry = searchCache.get(key);
    if (!entry) return null;

    // 检查是否过期
    if (Date.now() - entry.timestamp > CACHE_TTL) {
        searchCache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(keyword, data) {
    const key = getCacheKey(keyword);

    // 缓存满时淘汰最旧的条目
    if (searchCache.size >= CACHE_MAX_SIZE) {
        const oldestKey = searchCache.keys().next().value;
        searchCache.delete(oldestKey);
    }

    searchCache.set(key, { data, timestamp: Date.now() });
}

async function searchAndGetSong(keyword, log) {
    // 优先查缓存
    const cached = getFromCache(keyword);
    if (cached) {
        log.info({ keyword, title: cached.title }, '命中缓存，跳过上游请求');
        return cached;
    }

    log.info({ keyword }, '搜索歌曲...');

    // 依次尝试各上游
    for (const upstream of UPSTREAMS) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT);

            let result;
            if (upstream.type === 'lucky') {
                // Lucky API：直接返回完整结果（含真实播放链接）
                result = await searchFromLucky(upstream, keyword, controller.signal, log);
            } else if (upstream.type === 'kuwo') {
                // 酷我 API：直接返回完整结果
                result = await searchFromKuwo(upstream, keyword, controller.signal, log);
            } else {
                // QQ 音乐格式
                result = await searchFromQQMusic(upstream, keyword, controller.signal, log);
            }
            clearTimeout(timeout);

            if (result) {
                const finalResult = { ...result, source: upstream.name };
                log.info({ title: result.title, source: upstream.name }, '搜索成功');
                // 写入缓存
                setCache(keyword, finalResult);
                return finalResult;
            }
        } catch (e) {
            log.warn({ upstream: upstream.name, error: e.message }, '上游请求失败，尝试下一个');
        }
    }

    throw new Error('所有上游均不可用');
}

// QQ 音乐格式适配器
async function searchFromQQMusic(upstream, keyword, signal, log) {
    const searchUrl = `${upstream.url}${upstream.endpoints.search}?keyword=${encodeURIComponent(keyword)}&num=1`;
    const searchRes = await fetch(searchUrl, {
        signal,
        headers: { 'User-Agent': 'HBMusic/1.0' }
    });
    const searchData = await searchRes.json();

    if (searchData.code !== 0 || !searchData.data?.list?.length) {
        return null;
    }

    const song = searchData.data.list[0];
    const mid = song.mid;
    const songName = song.name || '未知歌曲';
    const artistName = (song.singer || []).map(s => s.name).join('/') || '未知歌手';
    const album = song.album || {};

    return {
        code: 200,
        title: songName,
        singer: artistName,
        cover: album.mid ? `https://y.qq.com/music/photo_new/T002R300x300M000${album.mid}.jpg` : '',
        link: `https://y.qq.com/n/ryqq/songDetail/${mid}`,
        music_url: `${CONFIG.BASE_URL}/fallback-stream?mid=${mid}`,
        lyric: `${CONFIG.BASE_URL}/fallback-lyric?mid=${mid}`,
    };
}

// Lucky API 适配器 - 直接返回真实播放链接
async function searchFromLucky(upstream, keyword, signal, log) {
    const searchUrl = `${upstream.url}?Love=${encodeURIComponent(keyword)}`;
    const searchRes = await fetch(searchUrl, {
        signal,
        headers: { 'User-Agent': 'HBMusic/1.0' }
    });
    const data = await searchRes.json();

    if (data.code !== 200 || !data.music_url) {
        return null;
    }

    // 从歌词中解析真实歌名和歌手（歌词格式：[ti:歌名] [ar:歌手]）
    let title = keyword;
    let singer = '未知歌手';
    let cleanLyric = '';
    if (data.lyric) {
        const titleMatch = data.lyric.match(/\[ti:([^\]]+)\]/);
        const artistMatch = data.lyric.match(/\[ar:([^\]]+)\]/);
        if (titleMatch) title = titleMatch[1];
        if (artistMatch) singer = artistMatch[1];

        // 过滤歌词中的广告行（包含 Lucky签、cer.luckying.love、点歌接口 等关键词）
        cleanLyric = data.lyric
            .split('\n')
            .filter(line => !line.includes('Lucky签') && !line.includes('cer.luckying.love') && !line.includes('点歌接口'))
            .join('\n');
    }

    return {
        code: 200,
        title,
        singer,
        cover: data.cover || '',
        link: data.link || '',
        music_url: data.music_url,  // 直接使用真实链接，无需代理
        lyric: cleanLyric,
    };
}

// 酷我 API 适配器（暂时禁用）
async function searchFromKuwo(upstream, keyword, signal, log) {
    const searchUrl = `${upstream.url}?name=${encodeURIComponent(keyword)}&page=1&limit=1`;
    const searchRes = await fetch(searchUrl, {
        signal,
        headers: { 'User-Agent': 'HBMusic/1.0' }
    });
    const searchData = await searchRes.json();

    if (searchData.code !== 200 || !searchData.data?.length) {
        return null;
    }

    const song = searchData.data[0];

    return {
        code: 200,
        title: song.name || '未知歌曲',
        singer: song.artist || '未知歌手',
        cover: song.pic || '',
        link: `https://www.kuwo.cn/play_detail/${song.rid}`,
        music_url: `${CONFIG.BASE_URL}/fallback-stream?rid=${song.rid}`,
        lyric: `${CONFIG.BASE_URL}/fallback-lyric?rid=${song.rid}`,
    };
}

async function fetchWithRetry(url, options = {}) {
    let lastError;
    for (let i = 0; i <= CONFIG.MAX_RETRIES; i++) {
        try {
            const res = await fetch(url, {
                ...options,
                headers: { 'User-Agent': 'Mozilla/5.0', ...options.headers }
            });
            if (res.status >= 500) throw new Error(`Server Error: ${res.status}`);
            return res;
        } catch (error) {
            lastError = error;
            if (i < CONFIG.MAX_RETRIES) await new Promise(r => setTimeout(r, 200 * (i + 1)));
        }
    }
    throw lastError;
}

// ============= 完整前端状态页 =============

function getStatusPageHTML(health) {
    const hexToRgb = (hex) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `${r}, ${g}, ${b}`;
    };
    const statusRgb = hexToRgb(health.color);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HBMusic | 服务状态</title>
    <style>
        :root { --wechat-green: #07C160; --status-color: ${health.color}; --status-rgb: ${statusRgb}; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif; 
            background: linear-gradient(135deg, #e0f7e9 0%, #f0f4f8 50%, #e8f4f8 100%);
            min-height: 100vh; 
            height: auto;
            display: flex; 
            flex-direction: column;
            align-items: center; 
            justify-content: flex-start;
            padding: 40px 20px 100px;
            color: #333;
            position: relative;
            -webkit-overflow-scrolling: touch;
        }
        
        /* 背景流光 (Aurora Blobs) */
        .blobs { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; filter: blur(80px); opacity: 0.5; }
        .blob { position: absolute; width: 300px; height: 300px; border-radius: 50%; animation: blobFloat 20s infinite alternate-reverse; }
        .blob-1 { background: rgba(7, 193, 96, 0.3); top: -50px; left: -50px; }
        .blob-2 { background: rgba(0, 122, 255, 0.2); bottom: -50px; right: -50px; animation-duration: 25s; }
        @keyframes blobFloat { 
            0% { transform: translate(0, 0) rotate(0deg) scale(1); }
            50% { transform: translate(100px, 50px) rotate(90deg) scale(1.1); }
            100% { transform: translate(-50px, 150px) rotate(180deg) scale(0.9); }
        }
        
        /* 动态波纹背景 */
        .waves { 
            position: fixed; 
            bottom: 0; 
            left: 0; 
            width: 100%; 
            height: 25vh;
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
            box-shadow: 
                0 15px 45px rgba(7, 193, 96, 0.1),
                inset 0 0 0 1px rgba(255, 255, 255, 0.6); 
            text-align: center; 
            position: relative; 
            z-index: 10;
            border: 1px solid rgba(255,255,255,0.4);
            margin-bottom: 20px;
            opacity: 0;
            transform: translateY(30px) scale(0.95);
            animation: cardPop 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275) 0.2s forwards;
        }
        @keyframes cardPop { to { opacity: 1; transform: translateY(0) scale(1); } }
        .logo { width: 72px; height: 72px; background: var(--wechat-green); border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: white; font-size: 36px; font-weight: bold; box-shadow: 0 8px 25px rgba(7, 193, 96, 0.3); }
        h1 { font-size: 26px; margin: 0 0 8px; font-weight: 700; color: #1a1a1a; }
        .subtitle { color: #666; font-size: 15px; margin-bottom: 24px; }
        .features { text-align: left; background: rgba(255, 255, 255, 0.5); padding: 20px; border-radius: 16px; margin-bottom: 24px; border: 1px solid rgba(255,255,255,0.4); }
        .feature-item { display: flex; align-items: center; margin-bottom: 16px; font-size: 14px; line-height: 1.4; color: #333; padding: 8px; border-radius: 12px; transition: all 0.2s; }
        .feature-item:hover { background: rgba(7, 193, 96, 0.05); transform: translateX(5px); }
        .feature-item:last-child { margin-bottom: 0; }
        .feature-icon { margin-right: 12px; font-size: 18px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); transition: transform 0.2s; }
        .feature-item:hover .feature-icon { transform: scale(1.2) rotate(10deg); }
        .status-box { border-top: 1px solid rgba(0,0,0,0.05); pt: 24px; margin-top: 12px; }
        .status-badge { display: inline-flex; align-items: center; background: rgba(var(--status-rgb), 0.1); color: var(--status-color); padding: 6px 16px; border-radius: 24px; font-size: 13px; font-weight: 600; margin-bottom: 16px; border: 1px solid rgba(var(--status-rgb), 0.15); }
        .status-dot { width: 8px; height: 8px; background: var(--status-color); border-radius: 50%; margin-right: 8px; position: relative; }
        .status-dot::after { content: ''; position: absolute; top: -4px; left: -4px; right: -4px; bottom: -4px; background: var(--status-color); border-radius: 50%; opacity: 0.4; animation: dotGlow 2s infinite; }
        @keyframes dotGlow { 0% { transform: scale(1); opacity: 0.4; } 100% { transform: scale(2.5); opacity: 0; } }
        
        /* 可折叠帮助卡片 */
        .help-toggle { 
            display: flex; align-items: center; justify-content: center;
            margin-top: 16px; padding: 10px 16px; 
            background: rgba(255, 255, 255, 0.5); border: 1px solid rgba(0,0,0,0.05); 
            border-radius: 12px; cursor: pointer; transition: all 0.3s;
            color: #666; font-size: 13px; font-weight: 500;
        }
        .help-toggle:hover { background: rgba(255, 255, 255, 0.7); }
        .help-toggle .icon { margin-right: 6px; transition: transform 0.3s; }
        .help-toggle.active .icon { transform: rotate(180deg); }
        .help-content {
            max-height: 0; overflow: hidden; transition: max-height 0.4s ease-out, opacity 0.3s, margin 0.3s;
            opacity: 0; margin-top: 0;
            font-size: 13px; color: #666; line-height: 1.8; text-align: left;
            background: rgba(255, 255, 255, 0.5); border-radius: 12px; padding: 0 14px;
        }
        .help-content.show { max-height: 500px; opacity: 1; margin-top: 12px; padding: 14px; }
        .help-content p { margin: 0 0 8px; }
        .help-content p:last-child { margin: 0; }
        .help-content .highlight { color: var(--wechat-green); font-weight: 600; }
        .copy-btn { margin-top: 12px; background: var(--wechat-green); color: white; border: none; padding: 12px 24px; border-radius: 12px; font-size: 14px; cursor: pointer; transition: all 0.3s; font-weight: 600; width: 100%; box-shadow: 0 4px 15px rgba(7, 193, 96, 0.2); }
        .copy-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(7, 193, 96, 0.3); }
        .copy-btn:active { transform: translateY(0); }
        .url-box { margin-top: 18px; font-family: 'SF Mono', 'Roboto Mono', monospace; font-size: 12px; background: rgba(255, 255, 255, 0.6); padding: 14px; border-radius: 14px; border: 1px solid rgba(0,0,0,0.05); word-break: break-all; color: var(--wechat-green); font-weight: 600; cursor: pointer; transition: all 0.2s; }
        .url-box:hover { background: rgba(255, 255, 255, 0.8); }
        
        /* 复制成功 Toast */
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
        
        /* 公告横幅 */
        .announcement-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: linear-gradient(90deg, #FF9500 0%, #FF6B00 100%);
            color: white;
            padding: 10px 20px;
            text-align: center;
            font-size: 13px;
            font-weight: 500;
            z-index: 1000;
            box-shadow: 0 2px 10px rgba(255, 149, 0, 0.3);
            animation: slideDown 0.5s ease-out;
        }
        .announcement-bar .icon { margin-right: 8px; }
        .announcement-bar .highlight { font-weight: 700; }

        /* 通知铃铛 */
        .notification-bell {
            position: fixed; top: 20px; right: 20px;
            width: 44px; height: 44px;
            background: rgba(255, 255, 255, 0.25);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 20px;
            cursor: pointer;
            border: 1px solid rgba(255, 255, 255, 0.3);
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            z-index: 1001;
        }
        .notification-bell:hover { transform: scale(1.1) rotate(10deg); background: rgba(255, 255, 255, 0.4); }
        .notification-bell .dot {
            position: absolute; top: 10px; right: 10px;
            width: 8px; height: 8px;
            background: #FF3B30;
            border-radius: 50%;
            border: 1px solid #fff;
            box-shadow: 0 0 0 0 rgba(255, 59, 48, 0.7);
            animation: pulse-red 2s infinite;
            display: none; /* 默认隐藏 */
        }
        .notification-bell.has-new .dot { display: block; }

        /* 更新弹窗 */
        .modal-backdrop {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            z-index: 2000;
            display: flex; align-items: center; justify-content: center;
            opacity: 0; pointer-events: none;
            transition: opacity 0.4s ease;
        }
        .modal-backdrop.show { opacity: 1; pointer-events: auto; }
        
        .update-modal {
            width: 90%; max-width: 360px;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 24px;
            padding: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.15), inset 0 0 0 1px rgba(255, 255, 255, 0.8);
            transform: scale(0.9) translateY(20px);
            transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            text-align: left;
        }
        .modal-backdrop.show .update-modal { transform: scale(1) translateY(0); }
        
        .modal-header { text-align: center; margin-bottom: 20px; }
        .modal-emoji { font-size: 48px; margin-bottom: 12px; display: block; animation: bounce 2s infinite; }
        .modal-title { font-size: 20px; font-weight: 800; color: #1a1a1a; margin-bottom: 4px; }
        .modal-subtitle { font-size: 13px; color: #666; }
        
        .update-list { margin-bottom: 24px; }
        .update-item { 
            display: flex; align-items: flex-start; margin-bottom: 12px; 
            font-size: 14px; color: #333; line-height: 1.5;
            background: rgba(0,0,0,0.03); padding: 10px; border-radius: 12px;
        }
        .update-item:last-child { margin-bottom: 0; }
        .update-tag { 
            font-size: 11px; padding: 2px 6px; border-radius: 6px; 
            margin-right: 8px; font-weight: 700; flex-shrink: 0; margin-top: 2px;
        }
        .tag-new { background: #e0f2f1; color: #00897b; }
        .tag-vip { background: #fff8e1; color: #ff8f00; }
        .tag-fix { background: #ffebee; color: #c62828; }
        .tag-opt { background: #e3f2fd; color: #1565c0; }
        
        .modal-btn {
            display: block; width: 100%;
            background: var(--wechat-green); color: white;
            font-size: 15px; font-weight: 700;
            padding: 14px; border-radius: 16px;
            border: none; cursor: pointer;
            transition: all 0.2s;
            box-shadow: 0 4px 15px rgba(7, 193, 96, 0.3);
        }
        .modal-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(7, 193, 96, 0.4); }
        .modal-btn:active { transform: scale(0.98); }

        @keyframes pulse-red { 0% { box-shadow: 0 0 0 0 rgba(255, 59, 48, 0.7); } 70% { box-shadow: 0 0 0 6px rgba(255, 59, 48, 0); } 100% { box-shadow: 0 0 0 0 rgba(255, 59, 48, 0); } }
        @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        @keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }
        body.has-announcement { padding-top: 50px; }
    </style>
</head>
<body class="${CONFIG.SHOW_ANNOUNCEMENT ? 'has-announcement' : ''}">
    <!-- 服务公告（通过 SHOW_ANNOUNCEMENT 环境变量控制） -->
    ${CONFIG.SHOW_ANNOUNCEMENT ? `
    <div class="announcement-bar">
        <span class="icon">🔧</span>
        <span>${CONFIG.ANNOUNCEMENT_TEXT}</span>
    </div>` : ''}
    
    <!-- 通知铃铛 -->
    <div class="notification-bell" id="bell" onclick="showUpdateModal()">
        🔔
        <div class="dot"></div>
    </div>
    
    <!-- 更新弹窗 -->
    <div class="modal-backdrop" id="updateModal">
        <div class="update-modal" onclick="event.stopPropagation()">
            <div class="modal-header">
                <span class="modal-emoji">🎉</span>
                <div class="modal-title">发现新版本</div>
                <div class="modal-subtitle">HBMusic 服务已自动升级</div>
            </div>
            
            <div class="update-list">
                <div class="update-item">
                    <span class="update-tag tag-vip">VIP</span>
                    <span><b>全链路权益解锁</b><br>支持无损音质及 VIP 专享曲目点播</span>
                </div>
                <div class="update-item">
                    <span class="update-tag tag-opt">PRO</span>
                    <span><b>沉浸式视听体验</b><br>重构歌词渲染引擎，界面纯净无扰</span>
                </div>
                <div class="update-item">
                    <span class="update-tag tag-new">NEW</span>
                    <span><b>高性能解析内核</b><br>多节点智能路由，响应延迟降低 30%</span>
                </div>
            </div>
            
            <button class="modal-btn" onclick="closeUpdateModal()">立即体验</button>
        </div>
    </div>

    <!-- 背景流光 -->
    <div class="blobs">
        <div class="blob blob-1"></div>
        <div class="blob blob-2"></div>
    </div>

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
                ${health.text}
            </div>
            <div class="url-box" id="apiUrl" onclick="copyUrl()">https://hbmusic.1yo.cc/?name=</div>
            <button class="copy-btn" onclick="copyUrl()">一键复制地址</button>
            
            <div class="help-toggle" onclick="toggleHelp(this)">
                <span class="icon">❓</span> 使用帮助
            </div>
            <div class="help-content" id="helpContent">
                <p style="color: #FF9500; margin-bottom: 8px;">⚠️ <b>温馨提示</b></p>
                <p>此前有人恶意刷歌，导致资源浪费严重。为确保长期稳定运行，请合理使用点歌功能，避免频繁刷歌。感谢您的理解与支持！💖</p>
                <hr style="border: none; border-top: 1px dashed rgba(0,0,0,0.1); margin: 12px 0;">
                <p>💡 若点歌插件无响应，请先访问此页确认<span class="highlight">服务状态</span></p>
                <p>✅ 页面能正常打开 = 后端运行正常</p>
                <p>📦 如有问题请点击右下角客服咨询</p>
            </div>
        </div>
    </div>

    <!-- Toast 弹窗 -->
    <div id="toast">
        <svg class="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
            <circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
            <path class="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8" stroke="white" stroke-width="3"/>
        </svg>
        <div class="success-text">复制成功 🎉</div>
        <div class="sub-text">地址已复制到剪贴板</div>
    </div>

    <script>
        // 版本号 - 每次更新修改此值，会自动弹出提示
        const CURRENT_VERSION = '2026.02.07';

        function checkUpdate() {
            const savedVersion = localStorage.getItem('hbmusic_version');
            const bell = document.getElementById('bell');
            
            if (savedVersion !== CURRENT_VERSION) {
                // 有新版本：显示红点，自动弹窗
                bell.classList.add('has-new');
                setTimeout(() => {
                    showUpdateModal();
                }, 800); // 延迟一点弹出，体验更好
            } else {
                bell.classList.remove('has-new');
            }
        }

        function showUpdateModal() {
            const modal = document.getElementById('updateModal');
            modal.classList.add('show');
        }

        function closeUpdateModal() {
            const modal = document.getElementById('updateModal');
            modal.classList.remove('show');
            
            // 标记已读
            localStorage.setItem('hbmusic_version', CURRENT_VERSION);
            document.getElementById('bell').classList.remove('has-new');
        }

        // 加载时检查
        window.addEventListener('load', checkUpdate);

        function copyUrl() {
            const url = document.getElementById('apiUrl').innerText;
            navigator.clipboard.writeText(url).then(() => {
                const toast = document.getElementById('toast');
                toast.style.display = 'block';
                setTimeout(() => { toast.style.display = 'none'; }, 2000);
            });
        }
        
        function toggleHelp(el) {
            el.classList.toggle('active');
            const content = document.getElementById('helpContent');
            content.classList.toggle('show');
        }
    </script>

    <!-- Chatway 客服组件 -->
    <script id="chatway" async="true" src="https://cdn.chatway.app/widget.js?id=i5GVIcMxReNp"></script>
</body>
</html>`;
}

// ============= 启动服务 =============
try {
    await app.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
    console.log(`
╔═══════════════════════════════════════════════════╗
║          🎵 HBMusic 点歌服务已启动                ║
╠═══════════════════════════════════════════════════╣
║  地址: http://${CONFIG.HOST}:${CONFIG.PORT}
║  上游: ${CONFIG.QQMUSIC_API}
╚═══════════════════════════════════════════════════╝
  `);
} catch (err) {
    app.log.error(err);
    process.exit(1);
}
