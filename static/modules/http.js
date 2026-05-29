/**
 * 统一 HTTP 客户端 · 自动重试 + 错误兜底 Toast
 * ============================================================
 * 核心能力：
 *   1) 网络错误 / 5xx / 408 / 429 自动重试（指数退避 + 抖动）
 *   2) 请求级超时（默认 12s），AbortController 真正中断
 *   3) 业务错误（resp.ok && code !== 0）统一抛 BizError，附带后端 message/detail
 *   4) onError 默认弹 toast.error，可关闭：{ silent: true }
 *   5) JSON / FormData 自适应：FormData 不会强行注入 Content-Type
 *   6) GET 默认带 cache: 'no-store'，避免 BFCache 取到旧元数据
 *
 * 使用：
 *   import { http } from './http.js';
 *   const data = await http.post('/api/bookings', body);
 *   const list = await http.get('/api/services');
 *   await http.put(`/api/admin/services/${id}`, payload, { auth: true, silent: true });
 */

import { toast } from './toast.js';

const DEFAULTS = {
    timeout: 12000,
    retries: 2,            // 总尝试次数 = retries + 1
    retryDelay: 600,       // 首次重试延迟 ms（之后按 1.7 倍指数 + ±20% 抖动）
    retryOn: [408, 425, 429, 500, 502, 503, 504],
    retryMethods: ['GET', 'HEAD', 'PUT', 'DELETE'], // 默认 POST 不重试（避免重复下单）
    silent: false,
};

export class BizError extends Error {
    constructor(message, { code, status, detail } = {}) {
        super(message);
        this.name = 'BizError';
        this.code = code;
        this.status = status;
        this.detail = detail;
    }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function withJitter(base) {
    const jitter = base * (0.8 + Math.random() * 0.4); // ±20%
    return Math.round(jitter);
}

function getAuthHeader(auth) {
    if (!auth) return {};
    try {
        // 与 admin.js 的 TOKEN_KEY 保持一致；兼容老 key
        const tk = localStorage.getItem('yx_admin_token')
                || localStorage.getItem('admin_token');
        return tk ? { Authorization: `Bearer ${tk}` } : {};
    } catch { return {}; }
}

/**
 * 统一请求函数
 * @param {string} url
 * @param {object} opts  fetch 选项 + { timeout, retries, retryDelay, retryOn, retryMethods, silent, auth, body }
 *   - body: 普通对象会自动 JSON 序列化；FormData / Blob / string 原样透传
 *   - silent: true 时静默错误（不弹 toast），仅抛异常
 *   - auth:   true 时自动从 localStorage.admin_token 注入 Bearer
 */
export async function request(url, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { ...(opts.headers || {}), ...getAuthHeader(opts.auth) };

    let body = opts.body;
    if (body !== undefined && body !== null
        && !(body instanceof FormData)
        && !(body instanceof Blob)
        && typeof body !== 'string') {
        body = JSON.stringify(body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }

    const fetchOpts = {
        method,
        headers,
        body,
        cache: opts.cache ?? (method === 'GET' ? 'no-store' : 'default'),
        credentials: opts.credentials || 'same-origin',
    };

    const maxAttempts = (cfg.retryMethods.includes(method) ? cfg.retries : 0) + 1;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), cfg.timeout);
        try {
            const resp = await fetch(url, { ...fetchOpts, signal: ctrl.signal });
            clearTimeout(tid);

            // 5xx / 408 / 429 触发重试（仅重试方法）
            if (cfg.retryOn.includes(resp.status) && attempt < maxAttempts) {
                lastErr = new BizError(`HTTP ${resp.status}`, { status: resp.status });
                await delay(withJitter(cfg.retryDelay * Math.pow(1.7, attempt - 1)));
                continue;
            }

            // 解析 body：优先 JSON，其次 text
            const ct = resp.headers.get('content-type') || '';
            let payload = null;
            if (ct.includes('application/json')) {
                payload = await resp.json().catch(() => null);
            } else {
                const txt = await resp.text().catch(() => '');
                payload = txt ? { detail: txt } : null;
            }

            if (!resp.ok) {
                const detail = payload?.detail || payload?.message || `请求失败（${resp.status}）`;
                const msg = typeof detail === 'string' ? detail : '请求失败';
                throw new BizError(msg, {
                    status: resp.status,
                    code: payload?.code,
                    detail: payload,
                });
            }

            // 业务包装：{code, message, data}；code !== 0 视为业务错误
            if (payload && typeof payload === 'object'
                && 'code' in payload && payload.code !== 0) {
                throw new BizError(payload.message || '操作失败', {
                    code: payload.code, status: resp.status, detail: payload,
                });
            }

            return payload;
        } catch (err) {
            clearTimeout(tid);
            // AbortError（超时）允许在重试范围内继续
            const isAbort = err.name === 'AbortError';
            const isNet   = err instanceof TypeError;
            const canRetry = (isAbort || isNet) && attempt < maxAttempts && cfg.retryMethods.includes(method);
            lastErr = err;
            if (canRetry) {
                await delay(withJitter(cfg.retryDelay * Math.pow(1.7, attempt - 1)));
                continue;
            }
            // 非业务异常包成 BizError 抛出
            if (!(err instanceof BizError)) {
                lastErr = new BizError(
                    isAbort ? '请求超时，请稍后重试' : '网络异常，请检查网络后重试',
                    { status: 0, detail: String(err.message || err) },
                );
            }
            break;
        }
    }

    // 统一兜底 toast
    if (!cfg.silent && lastErr) {
        try {
            toast.error(lastErr.message || '请求失败');
            // 401 提示去登录
            if (lastErr.status === 401) {
                setTimeout(() => {
                    if (location.pathname.includes('admin') || location.pathname.includes('audit')) {
                        try {
                            localStorage.removeItem('yx_admin_token');
                            localStorage.removeItem('admin_token');
                        } catch {}
                        location.href = '/static/admin.html';
                    }
                }, 600);
            }
        } catch {}
    }
    throw lastErr;
}

export const http = {
    get:    (url, opts = {}) => request(url, { ...opts, method: 'GET' }),
    post:   (url, body, opts = {}) => request(url, { ...opts, method: 'POST', body }),
    put:    (url, body, opts = {}) => request(url, { ...opts, method: 'PUT',  body }),
    patch:  (url, body, opts = {}) => request(url, { ...opts, method: 'PATCH', body }),
    delete: (url, opts = {}) => request(url, { ...opts, method: 'DELETE' }),
};

export default http;
