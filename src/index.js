/**
 * HBMusic - 微信点歌插件后端服务
 * 
 * 基于 TuneHub API，支持网易云、QQ音乐、酷我音乐
 * 优先使用酷我音源，自动换源保证可用性
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';

// 解决下游 TuneHub 服务证书过期问题
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ============= 配置 =============
const CONFIG = {
    PORT: parseInt(process.env.PORT || '3000'),
    HOST: process.env.HOST || '0.0.0.0',
    // TuneHub V3 API
    TUNEHUB_BASE: process.env.TUNEHUB_BASE || 'https://tunehub.sayqz.com/api',
    TUNEHUB_API_KEY: process.env.TUNEHUB_API_KEY || '',
    BITRATE: process.env.BITRATE || '320k',
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '2'),
    // 音源优先级：酷我优先
    SOURCE_PRIORITY: (process.env.SOURCE_PRIORITY || 'kuwo,netease,qq').split(','),
    // 备用：酷我第三方 API（无需积分）
    KUWO_FALLBACK_API: process.env.KUWO_FALLBACK_API || 'https://kw-api.cenguigui.cn',
    KUWO_FALLBACK_QUALITY: process.env.KUWO_FALLBACK_QUALITY || 'standard',
    // 强制使用备用 API（手动切换开关）
    FORCE_FALLBACK: process.env.FORCE_FALLBACK === 'true',
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

// ============= 服务健康自检 =============
// 缓存状态，避免每次请求都探测
let cachedHealthStatus = { status: 'ok', text: '服务在线 · 运行正常', color: '#07C160', lastCheck: 0 };
const HEALTH_CHECK_INTERVAL = 60000; // 60秒缓存

/**
 * 内部健康检查（动态检测实际使用的音源）
 */
async function checkServiceHealth() {
    const now = Date.now();
    if (now - cachedHealthStatus.lastCheck < HEALTH_CHECK_INTERVAL) {
        return cachedHealthStatus;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        let res;
        if (CONFIG.FORCE_FALLBACK) {
            // 检测备用 API（kw-api.cenguigui.cn）
            res = await fetch(`${CONFIG.KUWO_FALLBACK_API}?name=test&page=1&limit=1`, {
                signal: controller.signal,
                headers: { 'User-Agent': 'HBMusic-HealthCheck/1.0' }
            });
        } else {
            // 检测 TuneHub API
            res = await fetch(`${CONFIG.TUNEHUB_BASE}/v1/methods`, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'HBMusic-HealthCheck/1.0',
                    'X-API-Key': CONFIG.TUNEHUB_API_KEY
                }
            });
        }
        clearTimeout(timeout);

        if (res.ok) {
            cachedHealthStatus = { status: 'ok', text: '服务在线 · 运行正常', color: '#07C160', lastCheck: now };
        } else if (res.status < 500) {
            // 4xx 错误可能是探测参数问题，但服务本身是活的
            cachedHealthStatus = { status: 'ok', text: '服务在线 · 运行正常', color: '#07C160', lastCheck: now };
        } else {
            app.log.warn({ code: res.status }, '上游服务响应异常');
            cachedHealthStatus = { status: 'degraded', text: '服务波动 · 正在修复', color: '#FF9500', lastCheck: now };
        }
    } catch (error) {
        // 证书过期等连接异常
        if (error.name === 'AbortError') {
            app.log.warn('上游服务响应超时');
            cachedHealthStatus = { status: 'degraded', text: '服务波动 · 响应缓慢', color: '#FF9500', lastCheck: now };
        } else if (error.message?.includes('certificate') || error.code === 'CERT_HAS_EXPIRED') {
            // 证书过期，但已开启兼容模式
            app.log.warn('上游服务证书异常，已开启兼容模式');
            cachedHealthStatus = { status: 'ok', text: '服务在线 · 兼容模式', color: '#07C160', lastCheck: now };
        } else {
            app.log.error({ error: error.message }, '上游服务完全不可用');
            cachedHealthStatus = { status: 'error', text: '服务维护中', color: '#FF3B30', lastCheck: now };
        }
    }

    return cachedHealthStatus;
}

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

        // 获取服务状态
        const health = await checkServiceHealth();
        // 将十六进制色转换为 RGB
        const hexToRgb = (hex) => {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `${r}, ${g}, ${b}`;
        };
        const statusRgb = hexToRgb(health.color);

        const html = `
<!DOCTYPE html>
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
            /* 内发光与外阴影结合 */
            box-shadow: 
                0 15px 45px rgba(7, 193, 96, 0.1),
                inset 0 0 0 1px rgba(255, 255, 255, 0.6); 
            text-align: center; 
            position: relative; 
            z-index: 10;
            border: 1px solid rgba(255,255,255,0.4);
            margin-bottom: 20px;
            /* 进场动画 */
            opacity: 0;
            transform: translateY(30px) scale(0.95);
            animation: cardPop 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275) 0.2s forwards;
        }
        @keyframes cardPop {
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
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
        .help-content.show {
            max-height: 200px; opacity: 1; margin-top: 12px; padding: 14px;
        }
        .help-content p { margin: 0 0 8px; }
        .help-content p:last-child { margin: 0; }
        .help-content .highlight { color: var(--wechat-green); font-weight: 600; }
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
                <p>由于上游平台调整，本服务运营存在成本开支。为确保长期稳定运行，请合理使用点歌功能，避免频繁刷歌。感谢您的理解与支持！💖</p>
                <hr style="border: none; border-top: 1px dashed rgba(0,0,0,0.1); margin: 12px 0;">
                <p>💡 若点歌插件无响应，请先访问此页确认<span class="highlight">服务状态</span></p>
                <p>✅ 页面能正常打开 = 后端运行正常</p>
                <p>📦 如有问题请点击右下角客服咨询</p>
            </div>
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

// 音频流代理（使用 V3 API 解析）
app.get('/stream', async (request, reply) => {
    const { source, id, br } = request.query;

    if (!source || !id) {
        return reply.code(400).send({ error: '缺少 source 或 id 参数' });
    }

    const bitrate = br || CONFIG.BITRATE;

    try {
        // 调用 V3 解析接口获取音频 URL（消耗积分）
        const parseRes = await fetch(`${CONFIG.TUNEHUB_BASE}/v1/parse`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': CONFIG.TUNEHUB_API_KEY
            },
            body: JSON.stringify({
                platform: source,
                ids: String(id),
                quality: bitrate
            })
        });

        if (!parseRes.ok) {
            return reply.code(502).send({ error: '解析失败' });
        }

        const parseData = await parseRes.json();
        // V3 API 返回嵌套结构
        const songs = parseData.data?.data;
        if (parseData.code !== 0 || !songs?.length || !songs[0].success) {
            return reply.code(404).send({ error: '未找到音频' });
        }

        const audioUrl = songs[0].url;
        if (!audioUrl) {
            return reply.code(404).send({ error: '音频链接不可用' });
        }

        // 请求真实音频并转发
        const headers = {};
        if (request.headers.range) {
            headers['Range'] = request.headers.range;
        }
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

        // 对网易云添加 Referer
        if (source === 'netease') {
            headers['Referer'] = 'https://music.163.com/';
        }

        const audioRes = await fetch(audioUrl, { headers });

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

// 封面代理（使用 V3 API 解析获取封面 URL）
app.get('/cover', async (request, reply) => {
    const { source, id } = request.query;

    if (!source || !id) {
        return reply.code(400).send({ error: '缺少参数' });
    }

    try {
        // 调用 V3 解析接口获取封面
        const parseRes = await fetch(`${CONFIG.TUNEHUB_BASE}/v1/parse`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': CONFIG.TUNEHUB_API_KEY
            },
            body: JSON.stringify({
                platform: source,
                ids: String(id),
                quality: CONFIG.BITRATE
            })
        });

        if (!parseRes.ok) {
            return reply.code(502).send({ error: '解析失败' });
        }

        const parseData = await parseRes.json();
        // V3 API 返回嵌套结构
        const songs = parseData.data?.data;
        if (parseData.code !== 0 || !songs?.length || !songs[0].success) {
            return reply.code(404).send({ error: '未找到封面' });
        }

        const coverUrl = songs[0].cover;
        if (!coverUrl) {
            return reply.code(404).send({ error: '封面链接不可用' });
        }

        // 代理封面图片
        const res = await fetch(coverUrl, { redirect: 'follow' });
        reply.header('Content-Type', res.headers.get('content-type') || 'image/jpeg');
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.send(res.body);
    } catch (error) {
        return reply.code(502).send({ error: '封面获取失败' });
    }
});

// 歌词代理（使用 V3 API 解析获取歌词 URL）
app.get('/lyric', async (request, reply) => {
    const { source, id } = request.query;

    if (!source || !id) {
        return reply.code(400).send({ error: '缺少参数' });
    }

    try {
        // 调用 V3 解析接口获取歌词
        const parseRes = await fetch(`${CONFIG.TUNEHUB_BASE}/v1/parse`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': CONFIG.TUNEHUB_API_KEY
            },
            body: JSON.stringify({
                platform: source,
                ids: String(id),
                quality: CONFIG.BITRATE
            })
        });

        if (!parseRes.ok) {
            return reply.code(502).send({ error: '解析失败' });
        }

        const parseData = await parseRes.json();
        // V3 API 返回嵌套结构
        const songs = parseData.data?.data;
        if (parseData.code !== 0 || !songs?.length || !songs[0].success) {
            return reply.code(404).send({ error: '未找到歌词' });
        }

        const lrcUrl = songs[0].lyrics;
        if (!lrcUrl) {
            return reply.code(404).send({ error: '歌词不可用' });
        }

        // 获取歌词内容
        const res = await fetch(lrcUrl, { redirect: 'follow' });
        const lrcText = await res.text();
        reply.header('Content-Type', 'text/plain; charset=utf-8');
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.send(lrcText);
    } catch (error) {
        return reply.code(502).send({ error: '歌词获取失败' });
    }
});

// ============= 备用 API 代理端点（隐藏第三方 API 地址）=============

// 备用音频流代理
app.get('/fallback-stream', async (request, reply) => {
    const { id } = request.query;

    if (!id) {
        return reply.code(400).send({ error: '缺少 id 参数' });
    }

    try {
        // 调用第三方 API 获取音频
        const audioUrl = `${CONFIG.KUWO_FALLBACK_API}?id=${id}&type=song&level=${CONFIG.KUWO_FALLBACK_QUALITY}&format=mp3`;
        const audioRes = await fetch(audioUrl, {
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!audioRes.ok) {
            return reply.code(502).send({ error: '音频获取失败' });
        }

        // 转发响应
        reply.header('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
        reply.header('Accept-Ranges', 'bytes');
        if (audioRes.headers.get('content-length')) {
            reply.header('Content-Length', audioRes.headers.get('content-length'));
        }

        return reply.send(audioRes.body);
    } catch (error) {
        request.log.error(error, '备用音频代理失败');
        return reply.code(502).send({ error: '音频获取失败' });
    }
});

// 备用歌词代理
app.get('/fallback-lyric', async (request, reply) => {
    const { id } = request.query;

    if (!id) {
        return reply.code(400).send({ error: '缺少 id 参数' });
    }

    try {
        const lrcUrl = `${CONFIG.KUWO_FALLBACK_API}?id=${id}&type=lyr&format=all`;
        const res = await fetch(lrcUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (!res.ok) {
            return reply.code(502).send({ error: '歌词获取失败' });
        }

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
 * 优先使用 TuneHub API，积分不足或失败时降级到备用 API
 */
async function searchAndGetSongInfo(keyword, log) {
    // 强制使用备用 API（手动切换开关）
    if (CONFIG.FORCE_FALLBACK) {
        log.info({ keyword }, '强制使用备用 API (FORCE_FALLBACK=true)');
        try {
            const fallbackResult = await tryKuwoFallbackAPI(keyword, log);
            if (fallbackResult) {
                log.info({ title: fallbackResult.title }, '备用 API 获取成功');
                return fallbackResult;
            }
        } catch (fallbackError) {
            log.error({ error: fallbackError.message }, '备用 API 失败');
            return { code: 500, message: '备用 API 失败: ' + fallbackError.message };
        }
    }

    let lastError = null;
    let shouldFallback = false;

    // 优先尝试 TuneHub API（消耗积分）
    for (const source of CONFIG.SOURCE_PRIORITY) {
        try {
            const result = await tryGetSongFromSource(keyword, source, log);
            if (result) {
                log.info({ source, title: result.title }, '获取歌曲成功 (TuneHub)');
                return result;
            }
        } catch (error) {
            lastError = error;
            // 积分不足 (403/402) 或服务不可用时，标记需要降级
            if (error.message?.includes('403') || error.message?.includes('402') || error.message?.includes('积分')) {
                log.warn({ source, error: error.message }, 'TuneHub 积分不足，准备降级到备用 API');
                shouldFallback = true;
                break;
            }
            log.warn({ source, error: error.message }, '音源搜索失败，尝试下一个');
            continue;
        }
    }

    // 降级到备用 API（免费，无需积分）
    if (shouldFallback || lastError) {
        try {
            log.info({ keyword }, '尝试备用 API (kw-api.cenguigui.cn)');
            const fallbackResult = await tryKuwoFallbackAPI(keyword, log);
            if (fallbackResult) {
                log.info({ title: fallbackResult.title }, '备用 API 获取成功');
                return fallbackResult;
            }
        } catch (fallbackError) {
            log.error({ error: fallbackError.message }, '备用 API 也失败了');
        }
    }

    return { code: 404, message: `未找到歌曲: ${keyword}` };
}

/**
 * 从指定音源获取歌曲 (TuneHub V3 API)
 * 搜索使用方法下发模式（免费），解析使用 POST /v1/parse（消耗积分）
 */
async function tryGetSongFromSource(keyword, source, log) {
    // Step 1: 获取搜索方法配置（免费）
    const methodUrl = `${CONFIG.TUNEHUB_BASE}/v1/methods/${source}/search`;
    const methodRes = await fetchWithRetry(methodUrl, {
        headers: { 'X-API-Key': CONFIG.TUNEHUB_API_KEY }
    });

    if (!methodRes.ok) throw new Error(`获取搜索配置失败: ${methodRes.status}`);

    const methodData = await methodRes.json();
    if (methodData.code !== 0 || !methodData.data) {
        throw new Error('搜索配置无效');
    }

    const searchConfig = methodData.data;

    // Step 2: 替换模板变量并发起搜索请求（免费，直接请求上游）
    const searchParams = {};
    for (const [key, value] of Object.entries(searchConfig.params || {})) {
        // 替换所有模板变量 {{xxx}}
        let paramValue = String(value);
        paramValue = paramValue.replace(/\{\{keyword\}\}/gi, keyword);
        paramValue = paramValue.replace(/\{\{.*?page.*?\}\}/gi, '0');
        paramValue = paramValue.replace(/\{\{.*?limit.*?\}\}/gi, '10');
        paramValue = paramValue.replace(/\{\{.*?\}\}/g, ''); // 清理未知变量
        searchParams[key] = paramValue;
    }

    const searchUrl = new URL(searchConfig.url);
    searchUrl.search = new URLSearchParams(searchParams).toString();

    const searchRes = await fetch(searchUrl.toString(), {
        method: searchConfig.method || 'GET',
        headers: searchConfig.headers || {}
    });

    if (!searchRes.ok) throw new Error(`搜索失败: ${searchRes.status}`);

    // Step 3: 解析搜索结果（根据平台不同，响应格式不同）
    const searchText = await searchRes.text();
    const songId = extractSongId(searchText, source, log);

    if (!songId) {
        return null;
    }

    // Step 4: 调用解析接口获取播放链接（消耗积分）
    const parseUrl = `${CONFIG.TUNEHUB_BASE}/v1/parse`;
    const parseRes = await fetchWithRetry(parseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': CONFIG.TUNEHUB_API_KEY
        },
        body: JSON.stringify({
            platform: source,
            ids: String(songId),
            quality: CONFIG.BITRATE
        })
    });

    if (!parseRes.ok) throw new Error(`解析失败: ${parseRes.status}`);

    const parseData = await parseRes.json();
    // V3 API 返回嵌套结构: { data: { data: [...] } }
    const songs = parseData.data?.data;
    if (parseData.code !== 0 || !songs?.length || !songs[0].success) {
        throw new Error('解析歌曲失败');
    }

    const song = songs[0];
    const info = song.info || {};

    // 构建响应
    const baseUrl = process.env.BASE_URL || `http://localhost:${CONFIG.PORT}`;

    return {
        code: 200,
        title: info.name || '未知歌曲',
        singer: info.artist || '未知歌手',
        cover: song.cover || '',
        link: getDetailPageLink(source, songId),
        music_url: song.url || `${baseUrl}/stream?source=${source}&id=${songId}&br=${CONFIG.BITRATE}`,
        lyric: song.lyrics || `${baseUrl}/lyric?source=${source}&id=${songId}`,
        source
    };
}

/**
 * 从搜索响应中提取歌曲 ID（不同平台格式不同）
 */
function extractSongId(responseText, source, log) {
    try {
        const data = JSON.parse(responseText);

        if (source === 'kuwo') {
            // 酷我返回 JSON 格式: abslist[0].MUSICRID = "MUSIC_123456" 或 DC_TARGETID
            const song = data.abslist?.[0];
            if (!song) return null;

            // 优先使用 DC_TARGETID，否则从 MUSICRID 提取
            if (song.DC_TARGETID) return song.DC_TARGETID;
            if (song.MUSICRID) {
                const match = song.MUSICRID.match(/MUSIC_(\d+)/);
                return match ? match[1] : null;
            }
            return null;
        }

        if (source === 'netease') {
            // 网易云: result.songs[0].id
            return data.result?.songs?.[0]?.id;
        }

        if (source === 'qq') {
            // QQ音乐: data.song.list[0].songmid
            return data.data?.song?.list?.[0]?.songmid;
        }

        return null;
    } catch (e) {
        log.warn({ error: e.message, source }, '解析搜索结果失败');
        return null;
    }
}

/**
 * 备用 API：调用 kw-api.cenguigui.cn（免费，无需积分）
 */
async function tryKuwoFallbackAPI(keyword, log) {
    const url = `${CONFIG.KUWO_FALLBACK_API}?name=${encodeURIComponent(keyword)}&page=1&limit=1`;

    const res = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!res.ok) {
        throw new Error(`备用 API 请求失败: ${res.status}`);
    }

    const data = await res.json();
    if (data.code !== 200 || !data.data?.length) {
        throw new Error('备用 API 未找到结果');
    }

    const song = data.data[0];

    // 使用本地代理 URL，隐藏第三方 API 地址
    const baseUrl = process.env.BASE_URL || `http://localhost:${CONFIG.PORT}`;

    return {
        code: 200,
        title: song.name || '未知歌曲',
        singer: song.artist || '未知歌手',
        cover: song.pic || '',
        link: `https://www.kuwo.cn/play_detail/${song.rid}`,
        // 使用代理端点，不暴露第三方 API
        music_url: `${baseUrl}/fallback-stream?id=${song.rid}`,
        lyric: `${baseUrl}/fallback-lyric?id=${song.rid}`,
        source: 'kuwo-fallback'
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
