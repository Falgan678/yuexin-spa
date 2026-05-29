// 管理后台主脚本 - v2：登录、动态元数据、多维筛选、字段对齐
const TOKEN_KEY = 'yx_admin_token';
const USER_KEY = 'yx_admin_user';

let currentPage = 1;
let allBookings = [];
let filteredBookings = [];
const PAGE_SIZE = 10;

// 元数据（从后端拉取，与 services.js 对齐）
let META = {
    categories: [],
    services: [],
    statuses: [],
    sources: [],
    doctors: [],
    tags: [],
};
// 快速映射
const idToName = (arr, id) => (arr.find(x => x.id === id || x.name === id)?.name) || id || '-';

// ---------------- 自定义分类 / 标签 - 服务端权威 ----------------
// 不再使用 localStorage 缓存。所有自定义分类/标签实时通过 API 与服务端同步：
// - GET  /api/admin/categories  / /api/admin/tags
// - POST /api/admin/categories  / /api/admin/tags
// - DELETE /api/admin/categories/{id}?force=1
// 这样保证管理端、客户端两端永远看到完全一致的列表。
const SYNC_CHANNEL_NAME = 'yx-service-sync';
const SYNC_LS_KEY = 'yx_service_sync_tick';
let _syncBroadcaster = null;
function getBroadcaster() {
    if (_syncBroadcaster !== null) return _syncBroadcaster;
    try {
        _syncBroadcaster = (typeof BroadcastChannel !== 'undefined')
            ? new BroadcastChannel(SYNC_CHANNEL_NAME)
            : null;
    } catch { _syncBroadcaster = null; }
    return _syncBroadcaster;
}
/** 通知所有同源页面（含客户端）：服务/分类/标签发生变化，立即刷新对应列表。 */
function notifyServiceChanged(reason = 'service') {
    const payload = { type: 'service-changed', reason, ts: Date.now() };
    const bc = getBroadcaster();
    if (bc) {
        try { bc.postMessage(payload); } catch { /* ignore */ }
    }
    // 跨标签页 storage 事件兜底
    try { localStorage.setItem(SYNC_LS_KEY, String(payload.ts)); } catch { /* ignore */ }
}

// 自定义校验（与后端 CUSTOM_LABEL_RE / CUSTOM_CATEGORY_ID_RE 保持一致）
const CUSTOM_LABEL_RE = /^[\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,20}$/;
const CUSTOM_CATEGORY_ID_RE = CUSTOM_LABEL_RE;

// 内置标签集合（白名单 id -> 元信息）；自定义标签走通用样式
const BUILTIN_TAG_IDS = new Set(['hot', 'new', 'female', 'couple', 'recommend']);

// 合并后的分类列表（内置 + 自定义）—— 直接来自服务端
let allCategories = []; // [{id, name, icon, builtin, sort_order}]
// 合并后的标签列表（内置 + 自定义）—— 直接来自服务端
let allTags = [];       // [{id, label, color, builtin, sort_order}]

// ---------------- 启动 ----------------
document.addEventListener('DOMContentLoaded', async () => {
    initLoginForm();
    if (getToken()) {
        const ok = await tryEnterApp();
        if (!ok) showLogin();
    } else {
        showLogin();
    }
});

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }

const DEFAULT_TIMEOUT_MS = 12000;

async function apiFetch(url, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
        const resp = await fetch(url, { ...options, headers, signal: controller.signal });
        if (resp.status === 401) {
            clearToken();
            showLogin();
            throw new Error('未登录或会话已过期，请重新登录');
        }
        return resp;
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error(`请求超时，请检查后端服务是否正常（${Math.round(timeoutMs / 1000)} 秒未响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

async function readApiJson(resp) {
    const text = await resp.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`接口返回格式异常（HTTP ${resp.status}）：${text.slice(0, 120)}`);
    }
}

// ---------------- 登录 ----------------
function showLogin() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('adminApp').classList.add('hidden');
}
function showApp() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('adminApp').classList.remove('hidden');
}

function initLoginForm() {
    const form = document.getElementById('loginForm');
    const err = document.getElementById('loginError');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.classList.add('hidden');
        const u = document.getElementById('loginUsername').value.trim();
        const p = document.getElementById('loginPassword').value;
        if (!u || !p) { err.textContent = '请输入用户名和密码'; err.classList.remove('hidden'); return; }
        const submit = document.getElementById('loginSubmit');
        submit.disabled = true; const orig = submit.innerHTML;
        submit.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>登录中...';
        try {
            const resp = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: p }),
            });
            const result = await resp.json();
            if (resp.ok && result.code === 0) {
                setToken(result.data.token);
                localStorage.setItem(USER_KEY, result.data.username);
                await tryEnterApp();
            } else {
                err.textContent = result.detail || result.message || '登录失败';
                err.classList.remove('hidden');
            }
        } catch (e) {
            err.textContent = '网络错误，请稍后重试';
            err.classList.remove('hidden');
        } finally {
            submit.disabled = false; submit.innerHTML = orig;
        }
    });
}

/**
 * 渲染顶部导航栏的当前登录用户信息组件。
 * - 角色映射严格依赖后端 role_key（super_admin / admin / editor / viewer），
 *   未知 role_key 走 "custom" 视觉降级，保证不抛错、不溢出。
 * - 通过 textContent 写入用户输入字段，避免 XSS。
 */
function renderNavUser(me, fallbackUser) {
    const el = document.getElementById('navUser');
    if (!el) return;

    // 角色 → 视觉/文案映射（4 种内置 + 未知兜底）
    const ROLE_MAP = {
        super_admin: { variant: 'super',  icon: 'fa-crown',         text: '超级管理员', short: '超管' },
        admin:       { variant: 'admin',  icon: 'fa-user-shield',   text: '管理员',     short: '管理' },
        editor:      { variant: 'editor', icon: 'fa-pen-to-square', text: '运营',       short: '运营' },
        viewer:      { variant: 'viewer', icon: 'fa-eye',           text: '访客',       short: '访客' },
    };
    const roleKey = (me && me.role_key) || '';
    const roleConf = ROLE_MAP[roleKey] || {
        variant: 'custom',
        icon: 'fa-user-tag',
        // 自定义角色优先用后端返回的 role_name；否则兜底为 "未知角色"
        text: (me && me.role_name) || '未知角色',
        short: (me && me.role_name) || '其他',
    };

    const displayName = (me && (me.display_name || me.username)) || fallbackUser || '当前用户';

    // 进入已加载态
    el.classList.remove('is-loading', 'hidden');
    el.classList.add('md:inline-flex');
    el.setAttribute('data-role', roleKey || 'unknown');
    el.setAttribute('title',
        `${displayName}（${roleConf.text}${me && me.username ? ' · ' + me.username : ''}）`);

    // 显示名（textContent，防 XSS）
    const nameEl = el.querySelector('[data-bind="display-name"]');
    if (nameEl) {
        nameEl.textContent = displayName;
        nameEl.setAttribute('title', displayName);
    }

    // 角色徽章
    const badgeEl = el.querySelector('[data-bind="role-badge"]');
    if (badgeEl) {
        badgeEl.className = 'role-badge role-badge--' + roleConf.variant;
        badgeEl.setAttribute('data-role', roleKey || 'unknown');
        badgeEl.setAttribute('aria-label', '角色：' + roleConf.text);
        // 重建内部结构（图标 + 文字），保持与初始 HTML 一致
        badgeEl.innerHTML = '';
        const ic = document.createElement('i');
        ic.className = 'role-badge__icon fas ' + roleConf.icon;
        ic.setAttribute('aria-hidden', 'true');
        const txt = document.createElement('span');
        txt.className = 'role-badge__text';
        txt.textContent = roleConf.text;
        badgeEl.appendChild(ic);
        badgeEl.appendChild(txt);
    }
}

async function tryEnterApp() {
    try {
        const resp = await apiFetch('/api/admin/me');
        if (!resp.ok) throw new Error('me failed');
        const result = await resp.json();
        const me = result.data || {};
        const user = me.username || localStorage.getItem(USER_KEY) || 'admin';
        renderNavUser(me, user);

        // 拉取元数据
        const metaResp = await apiFetch('/api/admin/meta');
        const metaResult = await metaResp.json();
        if (metaResult.code === 0) META = metaResult.data;

        // 用 /api/admin/meta 返回的 categories/tags 作为权威源
        // （服务端已合并内置 + 自定义，且会在保存项目时自动 upsert）
        rebuildCustomCollections();
        // 再补一次拉取，作为确权（应对 META 在某些版本未带 tags 字段的兼容路径）
        await reloadCategoriesAndTags();

        fillFilterOptions();
        fillStatusModalOptions();

        showApp();
        initEventListeners();
        await loadStatistics();
        await loadAllBookings();
        await loadServices();
        await loadSettings();
        await loadOffers();
        await loadEnvironments();
        await loadDoctors();
        try { window.refreshUserMgmtAccess && window.refreshUserMgmtAccess(); } catch (_) {}
        return true;
    } catch (e) {
        console.error('进入后台失败:', e);
        return false;
    }
}

// ---------------- 填充筛选下拉项 ----------------
function fillFilterOptions() {
    const fillSelect = (id, list, valueKey = 'id', labelKey = 'name') => {
        const sel = document.getElementById(id);
        if (!sel) return;
        // 保留首项"全部 xxx"
        const first = sel.querySelector('option');
        sel.innerHTML = '';
        if (first) sel.appendChild(first);
        list.forEach(item => {
            const o = document.createElement('option');
            o.value = item[valueKey];
            o.textContent = item[labelKey];
            sel.appendChild(o);
        });
    };

    // 分类下拉：使用合并后的 allCategories（含内置 + 自定义），保证自定义分类立即可被筛选
    fillSelect('categoryFilter', allCategories);
    fillSelect('serviceFilter', META.services, 'name', 'name');
    fillSelect('statusFilter', META.statuses);
    fillSelect('sourceFilter', META.sources);

    // 服务项目管理 - 标签筛选下拉：动态填充
    const tagFilter = document.getElementById('svcTagFilter');
    if (tagFilter) {
        tagFilter.innerHTML = '<option value="">全部标签</option>';
        allTags.forEach(t => {
            const o = document.createElement('option');
            o.value = t.id;
            o.textContent = t.label;
            tagFilter.appendChild(o);
        });
    }

    // 服务下拉随分类变化（使用 allCategories 防止自定义分类匹配不到）
    const catSel = document.getElementById('categoryFilter');
    if (catSel && !catSel.dataset.bound) {
        catSel.dataset.bound = '1';
        catSel.addEventListener('change', e => {
            const cat = e.target.value;
            const sel = document.getElementById('serviceFilter');
            const cur = sel.value;
            sel.innerHTML = '<option value="">全部项目</option>';
            META.services
                .filter(s => !cat || s.category === cat)
                .forEach(s => {
                    const o = document.createElement('option');
                    o.value = s.name; o.textContent = s.name;
                    sel.appendChild(o);
                });
            // 若旧选项已不在分类内，则清空
            if (![...sel.options].some(o => o.value === cur)) sel.value = '';
        });
    }
}

function fillStatusModalOptions() {
    const host = document.getElementById('statusOptions');
    host.innerHTML = '';
    META.statuses.forEach(s => {
        const label = document.createElement('label');
        label.className = 'block';
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'bookingStatus';
        radio.value = s.id; radio.className = 'mr-2';
        label.appendChild(radio);
        const span = document.createElement('span');
        span.className = 'text-gray-700'; span.textContent = s.name;
        label.appendChild(span);
        host.appendChild(label);
    });
}

// ---------------- 事件 ----------------
function initEventListeners() {
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadStatistics();
        await loadAllBookings();
        showNotification('数据已刷新', 'success');
    });
    document.getElementById('logoutBtn').addEventListener('click', () => {
        clearToken();
        try { window.refreshUserMgmtAccess && window.refreshUserMgmtAccess(); } catch (_) {}
        showLogin();
    });

    // 跨标签页 / 跨端实时同步：当其它管理员窗口或客户端发布了分类/标签变更时，
    // 当前管理后台也立即刷新自身视图，保证多端永远一致。
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            const bc = new BroadcastChannel('yx-service-sync');
            bc.addEventListener('message', async (ev) => {
                if (ev.data && ev.data.type === 'service-changed') {
                    await reloadCategoriesAndTags();
                    fillFilterOptions();
                    // 刷新服务列表（如果当前在服务管理 Tab）
                    if (typeof loadServices === 'function') {
                        try { await loadServices(); } catch { /* 静默 */ }
                    }
                }
            });
        } catch { /* 静默 */ }
    }
    window.addEventListener('storage', async (e) => {
        if (e.key === 'yx_service_sync_tick') {
            await reloadCategoriesAndTags();
            fillFilterOptions();
            if (typeof loadServices === 'function') {
                try { await loadServices(); } catch { /* 静默 */ }
            }
        }
    });
    document.getElementById('searchBtn').addEventListener('click', applyFilters);
    document.getElementById('resetFilterBtn').addEventListener('click', resetFilters);
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('closeDetailBtn').addEventListener('click', closeDetailModal);
    document.getElementById('detailModal').addEventListener('click', (e) => {
        if (e.target.id === 'detailModal') closeDetailModal();
    });

    document.querySelectorAll('.stat-card').forEach(card => {
        card.addEventListener('click', () => showStatsDetail(card.dataset.statType));
    });

    document.getElementById('closeStatsBtn').addEventListener('click', closeStatsModal);
    document.getElementById('statsModal').addEventListener('click', (e) => {
        if (e.target.id === 'statsModal') closeStatsModal();
    });

    document.getElementById('closeStatusBtn').addEventListener('click', closeStatusModal);
    document.getElementById('cancelStatusBtn').addEventListener('click', closeStatusModal);
    document.getElementById('confirmStatusBtn').addEventListener('click', confirmStatusChange);
    document.getElementById('statusModal').addEventListener('click', (e) => {
        if (e.target.id === 'statusModal') closeStatusModal();
    });

    document.getElementById('closeNoteBtn').addEventListener('click', closeNoteModal);
    document.getElementById('cancelNoteBtn').addEventListener('click', closeNoteModal);
    document.getElementById('confirmNoteBtn').addEventListener('click', confirmNoteChange);
    document.getElementById('noteModal').addEventListener('click', (e) => {
        if (e.target.id === 'noteModal') closeNoteModal();
    });
    document.getElementById('noteTextarea').addEventListener('input', e => {
        document.getElementById('noteLen').textContent = e.target.value.length;
    });

    document.getElementById('prevPageBtn').addEventListener('click', () => {
        if (currentPage > 1) { currentPage--; renderBookings(); }
    });
    document.getElementById('nextPageBtn').addEventListener('click', () => {
        const totalPages = Math.max(1, Math.ceil(filteredBookings.length / PAGE_SIZE));
        if (currentPage < totalPages) { currentPage++; renderBookings(); }
    });

    // ===== 联系方式管理 =====
    document.getElementById('settingAddBtn').addEventListener('click', () => openSettingModal(null));
    document.getElementById('settingRefreshBtn').addEventListener('click', loadSettings);
    document.getElementById('settingSearchBtn').addEventListener('click', loadSettings);
    document.getElementById('settingSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') loadSettings();
    });
    document.getElementById('closeSettingBtn').addEventListener('click', closeSettingModal);
    document.getElementById('cancelSettingBtn').addEventListener('click', closeSettingModal);
    document.getElementById('confirmSettingBtn').addEventListener('click', confirmSettingSave);
    document.getElementById('settingModal').addEventListener('click', e => {
        if (e.target.id === 'settingModal') closeSettingModal();
    });

    // ===== 服务项目管理 =====
    initServicesAdmin();
}

// ---------------- 加载 ----------------
function daysParam() {
    const v = document.getElementById('dateFilter').value;
    return (!v || v === 'all') ? 3650 : parseInt(v, 10);
}

async function loadStatistics() {
    try {
        const resp = await apiFetch(`/api/analytics/stats?days=${daysParam()}`, { timeoutMs: 15000 });
        const result = await readApiJson(resp);
        if (result.code === 0) {
            const d = result.data || {};
            document.getElementById('totalVisits').textContent = d.total_visits ?? 0;
            document.getElementById('uniqueVisitors').textContent = d.unique_visitors ?? 0;
            document.getElementById('totalBookings').textContent = d.total_bookings ?? 0;
            document.getElementById('conversionRate').textContent = (d.conversion_rate ?? 0) + '%';
            const favEl = document.getElementById('totalFavorites');
            if (favEl) favEl.textContent = d.total_favorites ?? 0;

            renderBarList('bookingByService', d.booking_by_service, 'service', '次');
            renderBarList('bookingBySource',
                (d.booking_by_source || []).map(x => ({ ...x, source: idToName(META.sources, x.source) })),
                'source', '单');
            renderBarList('bookingByCategory',
                (d.booking_by_category || []).map(x => ({ ...x, category: idToName(allCategories, x.category) })),
                'category', '单');
            renderBarList('bookingByStatus',
                (d.booking_by_status || []).map(x => ({ ...x, status: idToName(META.statuses, x.status) })),
                'status', '单');
            // 收藏热度 TOP
            renderBarList('popularFavorites', d.popular_favorites || [], 'service', '次');
        }
    } catch (e) {
        if (e.message !== '未登录') {
            console.error('加载统计数据失败:', e);
            showNotification('加载统计数据失败', 'error');
        }
    }
}

function renderBarList(hostId, list, key, suffix) {
    const c = document.getElementById(hostId);
    c.innerHTML = '';
    if (!list || !list.length) {
        const p = document.createElement('p');
        p.className = 'text-gray-500 text-center py-4 text-sm';
        p.textContent = '暂无数据';
        c.appendChild(p);
        return;
    }
    const max = Math.max(...list.map(x => x.count || 0)) || 1;
    list.forEach((x, idx) => {
        const row = document.createElement('div');
        row.className = 'flex items-center space-x-3';
        const badge = document.createElement('div');
        badge.className = 'flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center text-white font-bold text-sm';
        badge.textContent = idx + 1;
        const main = document.createElement('div'); main.className = 'flex-1';
        const top = document.createElement('div'); top.className = 'flex items-center justify-between mb-1';
        const name = document.createElement('span'); name.className = 'text-gray-900 font-medium text-sm';
        name.textContent = x[key] || '未知';
        const cnt = document.createElement('span'); cnt.className = 'text-gray-600 text-sm';
        cnt.textContent = `${x.count} ${suffix}`;
        top.appendChild(name); top.appendChild(cnt);
        const bar = document.createElement('div'); bar.className = 'progress-bar';
        const fill = document.createElement('div'); fill.className = 'progress-fill';
        fill.style.width = `${(x.count / max * 100)}%`;
        bar.appendChild(fill); main.appendChild(top); main.appendChild(bar);
        row.appendChild(badge); row.appendChild(main);
        c.appendChild(row);
    });
}

function buildBookingQuery(extra = {}) {
    const params = new URLSearchParams();
    params.set('days', daysParam());
    params.set('limit', 1000);
    const cat = document.getElementById('categoryFilter').value;
    const svc = document.getElementById('serviceFilter').value;
    const st  = document.getElementById('statusFilter').value;
    const src = document.getElementById('sourceFilter').value;
    const kw  = document.getElementById('phoneSearch').value.trim();
    if (cat) params.set('category', cat);
    if (svc) params.set('service_type', svc);
    if (st)  params.set('status', st);
    if (src) params.set('source', src);
    if (kw)  params.set('keyword', kw);
    Object.entries(extra).forEach(([k,v]) => params.set(k, v));
    return params.toString();
}

async function loadAllBookings() {
    showLoading('正在加载历史订单...');
    try {
        const resp = await apiFetch(`/api/admin/bookings?${buildBookingQuery()}`, { timeoutMs: 15000 });
        const result = await readApiJson(resp);
        if (!resp.ok) {
            throw new Error(formatBackendError(result) || `接口请求失败（HTTP ${resp.status}）`);
        }
        if (result.code !== 0) {
            throw new Error(formatBackendError(result) || '加载预约失败');
        }
        if (!Array.isArray(result.data)) {
            throw new Error('接口返回格式异常：data 应为数组');
        }
        allBookings = result.data.map(normalizeBookingItem);
        filteredBookings = allBookings.slice();
        currentPage = 1;
        renderBookings();
    } catch (e) {
        console.error('加载预约失败:', e);
        if (String(e.message || '').includes('未登录')) {
            showErrorState('登录已过期，请重新登录后查看历史订单');
            showNotification('登录已过期，请重新登录', 'error');
        } else {
            const msg = e.message || '加载预约失败，请稍后重试';
            showErrorState(msg);
            showNotification(msg, 'error');
        }
    }
}

async function applyFilters() {
    currentPage = 1;
    await loadAllBookings();
}

function resetFilters() {
    document.getElementById('phoneSearch').value = '';
    document.getElementById('categoryFilter').value = '';
    document.getElementById('serviceFilter').value = '';
    document.getElementById('statusFilter').value = '';
    document.getElementById('sourceFilter').value = '';
    document.getElementById('dateFilter').value = '7';
    // 重新填充服务下拉为全部
    const sel = document.getElementById('serviceFilter');
    sel.innerHTML = '<option value="">全部项目</option>';
    META.services.forEach(s => {
        const o = document.createElement('option');
        o.value = s.name; o.textContent = s.name;
        sel.appendChild(o);
    });
    loadStatistics();
    loadAllBookings();
}

// ---------------- 渲染列表 ----------------
function normalizeBookingItem(item) {
    const b = (item && typeof item === 'object') ? item : {};
    return {
        id: b.id ?? '',
        name: b.name ?? '',
        phone: b.phone ?? '',
        datetime: b.datetime ?? '',
        note: b.note ?? '',
        service_type: b.service_type ?? '',
        category: b.category ?? '',
        source: b.source || 'normal',
        doctor: b.doctor ?? '',
        status: b.status || 'pending',
        created_at: b.created_at ?? '',
    };
}

function renderBookings() {
    try {
        hideLoading();
        if (!Array.isArray(filteredBookings)) filteredBookings = [];
        if (filteredBookings.length === 0) { showEmptyState(); return; }
        const tbody = document.getElementById('bookingTableBody');
        tbody.innerHTML = '';
        const start = (currentPage - 1) * PAGE_SIZE;
        filteredBookings.slice(start, start + PAGE_SIZE).forEach(b => tbody.appendChild(buildBookingRow(normalizeBookingItem(b))));
        document.getElementById('tableContainer').classList.remove('hidden');
        document.getElementById('emptyState').classList.add('hidden');
        updatePagination();
    } catch (e) {
        console.error('订单渲染失败:', e);
        showErrorState(`订单数据解析失败：${e.message || '未知错误'}`);
    }
}

function buildBookingRow(b) {
    const tr = document.createElement('tr');
    tr.className = 'animate-fade-in';
    tr.appendChild(cell(b.id));
    tr.appendChild(cell(b.name));
    tr.appendChild(cell(b.phone));
    tr.appendChild(cell(idToName(allCategories, b.category) || '-'));
    tr.appendChild(cell(b.service_type || '-'));
    tr.appendChild(cell(idToName(META.sources, b.source || 'normal')));
    tr.appendChild(cell(formatDateTime(b.datetime)));

    const tdStatus = document.createElement('td');
    tdStatus.className = 'px-6 py-4 whitespace-nowrap';
    const statusBtn = document.createElement('button');
    statusBtn.className = `status-badge status-${escapeAttr(b.status)} cursor-pointer hover:opacity-80`;
    statusBtn.textContent = idToName(META.statuses, b.status);
    statusBtn.addEventListener('click', () => openStatusModal(b.id, b.status));
    tdStatus.appendChild(statusBtn);
    tr.appendChild(tdStatus);

    const tdNote = document.createElement('td');
    tdNote.className = 'px-6 py-4 text-sm text-gray-600 max-w-xs';
    const noteBtn = document.createElement('button');
    noteBtn.className = 'text-left hover:text-emerald-600 truncate block w-full';
    noteBtn.textContent = b.note || '点击添加备注';
    noteBtn.addEventListener('click', () => openNoteModal(b.id, b.note || ''));
    tdNote.appendChild(noteBtn);
    tr.appendChild(tdNote);

    tr.appendChild(cell(formatDateTime(b.created_at)));

    const tdOp = document.createElement('td');
    tdOp.className = 'px-6 py-4 whitespace-nowrap text-sm font-medium';
    const viewBtn = document.createElement('button');
    viewBtn.className = 'text-emerald-600 hover:text-emerald-900';
    viewBtn.innerHTML = '<i class="fas fa-pen-to-square"></i> 编辑';
    viewBtn.addEventListener('click', () => viewDetail(b.id));
    tdOp.appendChild(viewBtn);
    tr.appendChild(tdOp);
    return tr;
}

function cell(text) {
    const td = document.createElement('td');
    td.className = 'px-6 py-4 whitespace-nowrap text-sm text-gray-900';
    td.textContent = (text === null || text === undefined) ? '' : String(text);
    return td;
}

function updatePagination() {
    const totalPages = Math.max(1, Math.ceil(filteredBookings.length / PAGE_SIZE));
    document.getElementById('totalCount').textContent = filteredBookings.length;
    document.getElementById('pageInfo').textContent = `第 ${currentPage} / ${totalPages} 页`;
    document.getElementById('prevPageBtn').disabled = currentPage === 1;
    document.getElementById('nextPageBtn').disabled = currentPage === totalPages;
    document.getElementById('paginationContainer').classList.remove('hidden');
}

// ---------------- 详情/编辑 ----------------
function viewDetail(id) {
    const booking = filteredBookings.find(b => b.id === id) || allBookings.find(b => b.id === id);
    if (!booking) return;
    renderDetailForm(booking);
    document.getElementById('detailModal').classList.add('active');
    document.getElementById('detailModal').classList.add('flex');
    document.getElementById('detailModal').classList.remove('hidden');
}

function renderDetailForm(b) {
    const c = document.getElementById('detailContent');
    c.innerHTML = '';
    const form = document.createElement('form');
    form.id = 'editBookingForm';
    form.className = 'space-y-4';
    form.appendChild(hidden('editBookingId', b.id));

    const row1 = grid2();
    row1.appendChild(readonlyField('预约 ID', b.id));
    row1.appendChild(selectField('当前状态', 'editStatus',
        META.statuses.map(s => [s.id, s.name]), b.status));
    form.appendChild(row1);

    const row2 = grid2();
    row2.appendChild(readonlyField('客户姓名', b.name));
    row2.appendChild(readonlyField('联系电话', b.phone));
    form.appendChild(row2);

    const row3 = grid2();
    row3.appendChild(selectField('服务分类', 'editCategory',
        [['', '保持原样'], ...allCategories.map(s => [s.id, s.name])], b.category || ''));
    row3.appendChild(selectField('服务项目', 'editServiceType',
        [['', '不修改'], ...META.services.map(s => [s.name, s.name])], b.service_type || ''));
    form.appendChild(row3);

    const row4 = grid2();
    row4.appendChild(datetimeField('预约时间', 'editDatetime', b.datetime));
    row4.appendChild(selectField('来源 / 套餐', 'editSource',
        META.sources.map(s => [s.id, s.name]), b.source || 'normal'));
    form.appendChild(row4);

    form.appendChild(selectField('医生选择', 'editDoctor',
        [['', '请选择医生'], ...META.doctors.map(d => [d, d])], b.doctor || ''));

    form.appendChild(textareaField('备注信息（最长 500 字）', 'editNote', b.note || '', 500));
    form.appendChild(readonlyField('创建时间', formatDateTime(b.created_at)));

    const actions = document.createElement('div');
    actions.className = 'flex justify-end space-x-3 pt-4 border-t border-gray-200';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'px-6 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600';
    cancel.textContent = '取消'; cancel.addEventListener('click', closeDetailModal);
    const save = document.createElement('button');
    save.type = 'submit'; save.className = 'px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700';
    save.innerHTML = '<i class="fas fa-save mr-2"></i>保存修改';
    actions.appendChild(cancel); actions.appendChild(save);
    form.appendChild(actions);

    form.addEventListener('submit', async e => {
        e.preventDefault();
        await saveBookingChanges();
    });

    c.appendChild(form);
}

function grid2() { const d = document.createElement('div'); d.className = 'grid grid-cols-2 gap-4'; return d; }
function readonlyField(label, value) {
    const w = document.createElement('div');
    const l = document.createElement('label');
    l.className = 'block text-sm font-medium text-gray-500 mb-1'; l.textContent = label;
    const p = document.createElement('p');
    p.className = 'text-gray-900'; p.textContent = (value == null) ? '-' : String(value);
    w.appendChild(l); w.appendChild(p);
    return w;
}
function selectField(label, id, options, selectedValue) {
    const w = document.createElement('div');
    const l = document.createElement('label');
    l.className = 'block text-sm font-medium text-gray-700 mb-2'; l.textContent = label;
    const s = document.createElement('select');
    s.id = id; s.className = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500';
    options.forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if (v === selectedValue) o.selected = true;
        s.appendChild(o);
    });
    w.appendChild(l); w.appendChild(s); return w;
}
function datetimeField(label, id, value) {
    const w = document.createElement('div');
    const l = document.createElement('label');
    l.className = 'block text-sm font-medium text-gray-700 mb-2'; l.textContent = label;
    const i = document.createElement('input');
    i.type = 'datetime-local'; i.id = id;
    i.className = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500';
    i.value = formatDateTimeForInput(value);
    w.appendChild(l); w.appendChild(i); return w;
}
function textareaField(label, id, value, maxLen) {
    const w = document.createElement('div');
    const l = document.createElement('label');
    l.className = 'block text-sm font-medium text-gray-700 mb-2'; l.textContent = label;
    const t = document.createElement('textarea');
    t.id = id; t.rows = 4; t.maxLength = maxLen || 500;
    t.className = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500';
    t.value = value || '';
    w.appendChild(l); w.appendChild(t); return w;
}
function hidden(id, value) {
    const i = document.createElement('input'); i.type = 'hidden'; i.id = id; i.value = value; return i;
}

function closeDetailModal() {
    const m = document.getElementById('detailModal');
    m.classList.remove('active'); m.classList.remove('flex'); m.classList.add('hidden');
}

async function saveBookingChanges() {
    const id = document.getElementById('editBookingId').value;
    const dt = document.getElementById('editDatetime').value;
    const status = document.getElementById('editStatus').value;
    const category = document.getElementById('editCategory').value;
    const service_type = document.getElementById('editServiceType').value;
    const source = document.getElementById('editSource').value;
    const doctor = document.getElementById('editDoctor').value;
    const note = document.getElementById('editNote').value;

    // 客户端校验
    if (dt && new Date(dt) <= new Date()) {
        showNotification('预约时间必须晚于当前时间', 'error');
        return;
    }
    if (note && note.length > 500) {
        showNotification('备注过长（不超过 500 字）', 'error');
        return;
    }

    // 仅提交有变化/有意义的字段
    const payload = { status, doctor, note };
    if (dt) payload.datetime = dt;
    if (category) payload.category = category;
    if (service_type) payload.service_type = service_type;
    if (source) payload.source = source;

    const btn = document.querySelector('#editBookingForm button[type="submit"]');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
    try {
        const resp = await apiFetch(`/api/bookings/${id}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification('预约信息保存成功', 'success');
            closeDetailModal();
            // 同步本地数据
            [allBookings, filteredBookings].forEach(arr => {
                const b = arr.find(x => x.id == id);
                if (!b) return;
                if (dt) b.datetime = dt;
                if (status) b.status = status;
                if (category) b.category = category;
                if (service_type) b.service_type = service_type;
                if (source) b.source = source;
                if (doctor !== undefined) b.doctor = doctor;
                if (note !== undefined) b.note = note;
            });
            renderBookings();
            loadStatistics();
        } else {
            showNotification(formatBackendError(result), 'error');
            btn.disabled = false; btn.innerHTML = orig;
        }
    } catch (e) {
        if (e.message !== '未登录') {
            showNotification('保存失败，请稍后重试', 'error');
        }
        btn.disabled = false; btn.innerHTML = orig;
    }
}

// 后端 422 错误格式化
function formatBackendError(result) {
    if (!result || typeof result !== 'object') return '接口返回格式异常';
    if (typeof result.detail === 'string') return result.detail;
    if (Array.isArray(result.detail)) {
        return result.detail.map(d => `${d.loc?.slice(-1)[0] || ''}: ${d.msg}`).join('; ');
    }
    return result.message || '操作失败';
}

// ---------------- 导出 CSV ----------------
function exportData() {
    if (filteredBookings.length === 0) { showNotification('没有可导出的数据', 'info'); return; }
    const csv = convertToCSV(filteredBookings);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `预约数据_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    showNotification('数据导出成功', 'success');
}
function csvSafe(v) {
    let s = (v == null) ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    s = s.replace(/"/g, '""');
    return `"${s}"`;
}
function convertToCSV(data) {
    const headers = ['ID','姓名','手机号','分类','项目','来源','预约时间','状态','备注','医生','创建时间'];
    const rows = data.map(b => [
        b.id, b.name, b.phone,
        idToName(allCategories, b.category),
        b.service_type || '',
        idToName(META.sources, b.source),
        formatDateTime(b.datetime),
        idToName(META.statuses, b.status),
        b.note || '', b.doctor || '',
        formatDateTime(b.created_at),
    ].map(csvSafe).join(','));
    return [headers.map(csvSafe).join(','), ...rows].join('\n');
}

// ---------------- 工具 ----------------
function formatDateTime(s) {
    if (!s) return '-';
    const normalized = typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)
        ? s.replace(' ', 'T')
        : s;
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatDateTimeForInput(s) {
    if (!s) return '';
    const normalized = typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)
        ? s.replace(' ', 'T')
        : s;
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function escapeAttr(s) { return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, ''); }

// ---------------- 状态修改弹窗 ----------------
function openStatusModal(id, currentStatus) {
    document.getElementById('statusBookingId').value = id;
    document.querySelectorAll('input[name="bookingStatus"]').forEach(r => r.checked = r.value === currentStatus);
    const m = document.getElementById('statusModal');
    m.classList.remove('hidden'); m.classList.add('flex');
}
function closeStatusModal() {
    const m = document.getElementById('statusModal');
    m.classList.add('hidden'); m.classList.remove('flex');
}
async function confirmStatusChange() {
    const id = document.getElementById('statusBookingId').value;
    const sel = document.querySelector('input[name="bookingStatus"]:checked');
    if (!sel) { showNotification('请选择状态', 'error'); return; }
    try {
        const resp = await apiFetch(`/api/bookings/${id}/status`, {
            method: 'PUT', body: JSON.stringify({ status: sel.value }),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification('状态修改成功', 'success');
            closeStatusModal();
            [allBookings, filteredBookings].forEach(arr => {
                const b = arr.find(x => x.id == id); if (b) b.status = sel.value;
            });
            renderBookings(); loadStatistics();
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录') showNotification('状态修改失败', 'error');
    }
}

// ---------------- 备注弹窗 ----------------
function openNoteModal(id, note) {
    document.getElementById('noteBookingId').value = id;
    const ta = document.getElementById('noteTextarea');
    ta.value = note || '';
    document.getElementById('noteLen').textContent = ta.value.length;
    const m = document.getElementById('noteModal');
    m.classList.remove('hidden'); m.classList.add('flex');
}
function closeNoteModal() {
    const m = document.getElementById('noteModal');
    m.classList.add('hidden'); m.classList.remove('flex');
}
async function confirmNoteChange() {
    const id = document.getElementById('noteBookingId').value;
    const note = document.getElementById('noteTextarea').value;
    if (note.length > 500) { showNotification('备注过长（不超过 500 字）', 'error'); return; }
    try {
        const resp = await apiFetch(`/api/bookings/${id}/note`, {
            method: 'PUT', body: JSON.stringify({ note }),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification('备注保存成功', 'success');
            closeNoteModal();
            [allBookings, filteredBookings].forEach(arr => {
                const b = arr.find(x => x.id == id); if (b) b.note = note;
            });
            renderBookings();
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录') showNotification('备注保存失败', 'error');
    }
}

// ---------------- 统计详情弹窗 ----------------
async function showStatsDetail(statType) {
    const modal = document.getElementById('statsModal');
    const title = document.getElementById('statsModalTitle');
    const content = document.getElementById('statsContent');
    const titles = {
        visits: '总访问量详情',
        visitors: '独立访客详情',
        bookings: '总预约数详情',
        conversion: '转化率详情',
        favorites: '收藏数据详情',
    };
    title.textContent = titles[statType] || '统计详情';
    content.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-4xl text-emerald-600"></i></div>';
    modal.classList.remove('hidden'); modal.classList.add('flex');

    try {
        const resp = await apiFetch(`/api/analytics/stats?days=${daysParam()}`);
        const result = await readApiJson(resp);
        if (result.code !== 0) { content.textContent = '加载失败'; return; }
        const d = result.data || {};
        content.innerHTML = '';
        content.appendChild(buildStatsBlock(statType, d, daysParam()));
    } catch (e) {
        content.innerHTML = '<div class="text-center py-8 text-red-600"><i class="fas fa-exclamation-circle text-4xl mb-2"></i><p>加载失败</p></div>';
    }
}

function buildStatsBlock(type, d, days) {
    const wrap = document.createElement('div'); wrap.className = 'space-y-4';
    const box = document.createElement('div'); box.className = 'p-6 rounded-lg';
    const h = document.createElement('h4'); h.className = 'text-lg font-bold mb-2';
    const big = document.createElement('p'); big.className = 'text-4xl font-bold';
    const sub = document.createElement('p'); sub.className = 'text-sm mt-2';
    if (type === 'visits') {
        box.classList.add('bg-blue-50'); h.textContent = '总访问量';
        big.textContent = d.total_visits; big.classList.add('text-blue-600');
        sub.textContent = `最近 ${days} 天的页面访问总次数`;
    } else if (type === 'visitors') {
        box.classList.add('bg-emerald-50'); h.textContent = '独立访客数';
        big.textContent = d.unique_visitors; big.classList.add('text-emerald-600');
        sub.textContent = `最近 ${days} 天的独立访客数量`;
    } else if (type === 'bookings') {
        box.classList.add('bg-purple-50'); h.textContent = '总预约数';
        big.textContent = d.total_bookings; big.classList.add('text-purple-600');
        sub.textContent = `最近 ${days} 天的预约总数`;
    } else if (type === 'favorites') {
        box.classList.add('bg-rose-50'); h.textContent = '总收藏数（净值）';
        big.textContent = d.total_favorites ?? 0; big.classList.add('text-rose-600');
        sub.textContent = `最近 ${days} 天：新增 ${d.favorite_add_total ?? 0} 次 / 取消 ${d.favorite_remove_total ?? 0} 次 / 收藏用户 ${d.unique_favorite_users ?? 0} 位`;
    } else {
        box.classList.add('bg-orange-50'); h.textContent = '转化率';
        big.textContent = (d.conversion_rate ?? 0) + '%'; big.classList.add('text-orange-600');
        sub.textContent = '访问到预约的转化率';
    }
    box.appendChild(h); box.appendChild(big); box.appendChild(sub);
    wrap.appendChild(box);

    // 收藏详情：附加趋势折线 + TOP 列表
    if (type === 'favorites') {
        const trendCard = document.createElement('div');
        trendCard.className = 'p-6 rounded-lg bg-white border border-gray-200';
        const tt = document.createElement('h4');
        tt.className = 'text-base font-bold mb-3 text-gray-800';
        tt.innerHTML = '<i class="fas fa-chart-line text-rose-500 mr-2"></i>每日新增收藏趋势';
        trendCard.appendChild(tt);
        trendCard.appendChild(buildFavoriteTrendChart(d.daily_favorites || []));
        wrap.appendChild(trendCard);

        const topCard = document.createElement('div');
        topCard.className = 'p-6 rounded-lg bg-white border border-gray-200';
        const tth = document.createElement('h4');
        tth.className = 'text-base font-bold mb-3 text-gray-800';
        tth.innerHTML = '<i class="fas fa-trophy text-amber-500 mr-2"></i>项目收藏 TOP';
        topCard.appendChild(tth);
        const topHost = document.createElement('div');
        topHost.id = 'favoriteTopList';
        topHost.className = 'space-y-3';
        topCard.appendChild(topHost);
        wrap.appendChild(topCard);
        // 渲染（直接用现成 renderBarList）
        setTimeout(() => renderBarList('favoriteTopList', d.popular_favorites || [], 'service', '次'), 0);
    }
    return wrap;
}

/** 用纯 SVG 绘制简易折线图（无第三方依赖）。 */
function buildFavoriteTrendChart(series) {
    const w = 720, h = 220, padL = 36, padR = 16, padT = 16, padB = 28;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'w-full h-auto');
    svg.style.maxWidth = '100%';

    if (!Array.isArray(series) || series.length === 0) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', w / 2); text.setAttribute('y', h / 2);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', '#9CA3AF');
        text.setAttribute('font-size', '14');
        text.textContent = '所选区间内没有收藏数据';
        svg.appendChild(text);
        return svg;
    }

    const counts = series.map(s => Number(s.count) || 0);
    const maxY = Math.max(1, ...counts);
    const stepX = (w - padL - padR) / Math.max(1, series.length - 1);
    const yOf = v => padT + (h - padT - padB) * (1 - v / maxY);

    // 网格 + Y 轴标签
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
        const y = padT + (h - padT - padB) * i / gridLines;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', padL); line.setAttribute('x2', w - padR);
        line.setAttribute('y1', y); line.setAttribute('y2', y);
        line.setAttribute('stroke', '#F3F4F6'); line.setAttribute('stroke-width', '1');
        svg.appendChild(line);
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', padL - 6); lbl.setAttribute('y', y + 4);
        lbl.setAttribute('text-anchor', 'end');
        lbl.setAttribute('fill', '#9CA3AF'); lbl.setAttribute('font-size', '11');
        lbl.textContent = String(Math.round(maxY * (1 - i / gridLines)));
        svg.appendChild(lbl);
    }

    // 折线
    const points = series.map((s, i) => `${padL + i * stepX},${yOf(Number(s.count) || 0)}`).join(' ');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', '#F43F5E');
    poly.setAttribute('stroke-width', '2.5');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    svg.appendChild(poly);

    // 区域填充
    const areaPts = `${padL},${h - padB} ${points} ${padL + (series.length - 1) * stepX},${h - padB}`;
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    area.setAttribute('points', areaPts);
    area.setAttribute('fill', 'rgba(244, 63, 94, 0.12)');
    svg.insertBefore(area, poly);

    // 数据点 + tooltip
    series.forEach((s, i) => {
        const cx = padL + i * stepX;
        const cy = yOf(Number(s.count) || 0);
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', 3.5);
        c.setAttribute('fill', '#fff'); c.setAttribute('stroke', '#F43F5E'); c.setAttribute('stroke-width', '2');
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        t.textContent = `${s.date}：新增 ${s.count} 次`;
        c.appendChild(t);
        svg.appendChild(c);
    });

    // X 轴标签：仅显示首/中/末
    const ticks = series.length <= 3 ? series : [series[0], series[Math.floor(series.length / 2)], series[series.length - 1]];
    ticks.forEach(t => {
        const idx = series.indexOf(t);
        const x = padL + idx * stepX;
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', x); lbl.setAttribute('y', h - 8);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('fill', '#9CA3AF'); lbl.setAttribute('font-size', '11');
        lbl.textContent = String(t.date || '').slice(5); // MM-DD
        svg.appendChild(lbl);
    });

    return svg;
}

function closeStatsModal() {
    const m = document.getElementById('statsModal');
    m.classList.add('hidden'); m.classList.remove('flex');
}

// ---------------- 状态切换 ----------------
function showLoading(text = '加载中...') {
    const loading = document.getElementById('loadingState');
    loading.innerHTML = '';
    const icon = document.createElement('i');
    icon.className = 'fas fa-spinner fa-spin text-4xl text-emerald-600 mb-4';
    const p = document.createElement('p');
    p.className = 'text-gray-600';
    p.textContent = text;
    loading.appendChild(icon);
    loading.appendChild(p);
    loading.classList.remove('hidden');
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('tableContainer').classList.add('hidden');
    document.getElementById('paginationContainer').classList.add('hidden');
}
function hideLoading() { document.getElementById('loadingState').classList.add('hidden'); }
function showEmptyState(message = '暂无预约记录') {
    hideLoading();
    const empty = document.getElementById('emptyState');
    empty.innerHTML = '';
    const icon = document.createElement('i');
    icon.className = 'fas fa-inbox text-6xl text-gray-300 mb-4';
    const p = document.createElement('p');
    p.className = 'text-gray-600 text-lg';
    p.textContent = message;
    empty.appendChild(icon);
    empty.appendChild(p);
    empty.classList.remove('hidden');
    document.getElementById('tableContainer').classList.add('hidden');
    document.getElementById('paginationContainer').classList.add('hidden');
}
function showErrorState(message) {
    hideLoading();
    const empty = document.getElementById('emptyState');
    empty.innerHTML = '';
    const icon = document.createElement('i');
    icon.className = 'fas fa-triangle-exclamation text-6xl text-red-400 mb-4';
    const p = document.createElement('p');
    p.className = 'text-red-600 text-lg font-medium';
    p.textContent = message || '加载失败';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'mt-4 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700';
    retry.innerHTML = '<i class="fas fa-rotate-right mr-2"></i>重试';
    retry.addEventListener('click', loadAllBookings);
    empty.appendChild(icon);
    empty.appendChild(p);
    empty.appendChild(retry);
    empty.classList.remove('hidden');
    document.getElementById('tableContainer').classList.add('hidden');
    document.getElementById('paginationContainer').classList.add('hidden');
}

// ---------------- 通知 ----------------
function showNotification(message, type = 'info') {
    const n = document.createElement('div');
    n.className = `notification ${type}`;
    const wrap = document.createElement('div');
    wrap.className = 'flex items-center space-x-3';
    const i = document.createElement('i');
    i.className = `fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'} text-xl`;
    const span = document.createElement('span');
    span.textContent = message;
    wrap.appendChild(i); wrap.appendChild(span); n.appendChild(wrap);
    document.body.appendChild(n);
    setTimeout(() => { n.style.opacity = '0'; setTimeout(() => n.parentNode && n.parentNode.removeChild(n), 300); }, 3000);
}

// ============================================================
// 联系我们管理
// ============================================================
let SETTINGS_LIST = [];
let editingSetting = null; // null = 新增；object = 编辑

const SETTING_TYPES = [
    { id: 'phone',  name: '电话',
      hint: '支持手机号 / 区号-座机 / 400 / 800（如 400-888-8888、0755-12345678、13800138000）' },
    { id: 'text',   name: '文本',  hint: '任意文本（1-500 字）' },
    { id: 'wechat', name: '微信号', hint: '字母开头，6-30 位字母 / 数字 / 下划线 / 连字符' },
    { id: 'email',  name: '邮箱',  hint: '标准邮箱格式，如 hello@example.com' },
    { id: 'url',    name: '链接',  hint: '必须以 http:// 或 https:// 开头' },
];

const COMMON_ICONS = [
    'fa-phone-alt', 'fa-map-marker-alt', 'far fa-clock', 'fab fa-weixin',
    'fab fa-qq', 'fab fa-weibo', 'fa-envelope', 'fa-globe', 'fa-circle-info',
    'fa-mobile-alt', 'fa-house', 'fa-comments',
];

async function loadSettings() {
    const kw = document.getElementById('settingSearch').value.trim();
    const url = '/api/admin/settings' + (kw ? `?keyword=${encodeURIComponent(kw)}` : '');
    try {
        const resp = await apiFetch(url);
        const result = await resp.json();
        if (result.code === 0) {
            SETTINGS_LIST = result.data || [];
            renderSettingTable();
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录') {
            console.error('加载联系方式失败:', e);
            showNotification('加载联系方式失败', 'error');
        }
    }
}

function renderSettingTable() {
    const tbody = document.getElementById('settingTableBody');
    const wrap = document.getElementById('settingTableWrap');
    const empty = document.getElementById('settingEmpty');
    tbody.innerHTML = '';
    if (!SETTINGS_LIST.length) {
        wrap.classList.add('hidden');
        empty.classList.remove('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    empty.classList.add('hidden');

    SETTINGS_LIST.forEach(item => {
        const tr = document.createElement('tr');
        tr.className = 'animate-fade-in hover:bg-gray-50';

        tr.appendChild(cell(item.sort_order));
        tr.appendChild(cell(item.label));

        const tdKey = document.createElement('td');
        tdKey.className = 'px-6 py-4 whitespace-nowrap text-sm text-gray-700';
        const code = document.createElement('code');
        code.className = 'bg-gray-100 px-2 py-1 rounded text-xs';
        code.textContent = item.key;
        tdKey.appendChild(code);
        tr.appendChild(tdKey);

        const typeMeta = SETTING_TYPES.find(t => t.id === item.type);
        tr.appendChild(cell(typeMeta ? typeMeta.name : item.type));

        const tdValue = document.createElement('td');
        tdValue.className = 'px-6 py-4 text-sm text-gray-900 max-w-xs truncate';
        tdValue.title = item.value || '';
        tdValue.textContent = item.value || '(未配置)';
        tr.appendChild(tdValue);

        const tdIcon = document.createElement('td');
        tdIcon.className = 'px-6 py-4 whitespace-nowrap text-sm text-gray-500';
        const ic = document.createElement('i');
        const cls = (item.icon || '').trim();
        ic.className = (cls.includes(' ') ? cls : `fas ${cls}`) + ' text-emerald-600 mr-2';
        const codeIcon = document.createElement('code');
        codeIcon.className = 'text-xs text-gray-400';
        codeIcon.textContent = item.icon;
        tdIcon.appendChild(ic); tdIcon.appendChild(codeIcon);
        tr.appendChild(tdIcon);

        const tdBuiltin = document.createElement('td');
        tdBuiltin.className = 'px-6 py-4 whitespace-nowrap';
        const badge = document.createElement('span');
        badge.className = item.builtin
            ? 'status-badge bg-amber-100 text-amber-800'
            : 'status-badge bg-emerald-100 text-emerald-800';
        badge.textContent = item.builtin ? '内置' : '自定义';
        tdBuiltin.appendChild(badge);
        tr.appendChild(tdBuiltin);

        tr.appendChild(cell(formatDateTime(item.updated_at)));

        const tdOp = document.createElement('td');
        tdOp.className = 'px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2';
        const editBtn = document.createElement('button');
        editBtn.className = 'text-emerald-600 hover:text-emerald-900';
        editBtn.innerHTML = '<i class="fas fa-pen-to-square"></i> 编辑';
        editBtn.addEventListener('click', () => openSettingModal(item));
        tdOp.appendChild(editBtn);

        if (!item.builtin) {
            const delBtn = document.createElement('button');
            delBtn.className = 'text-rose-600 hover:text-rose-900 ml-3';
            delBtn.innerHTML = '<i class="fas fa-trash"></i> 删除';
            delBtn.addEventListener('click', () => deleteSetting(item));
            tdOp.appendChild(delBtn);
        }
        tr.appendChild(tdOp);

        tbody.appendChild(tr);
    });
}

function openSettingModal(item) {
    editingSetting = item;
    document.getElementById('settingModalTitle').textContent = item ? '编辑联系方式' : '新增联系方式';
    const host = document.getElementById('settingFormFields');
    host.innerHTML = '';

    // key
    const keyWrap = settingTextField('Key（标识）', 'settingKey',
        item ? item.key : '',
        '小写字母开头，2-40 位字母数字下划线');
    if (item) keyWrap.querySelector('input').disabled = true;
    host.appendChild(keyWrap);

    // label
    host.appendChild(settingTextField('显示标签', 'settingLabel',
        item ? item.label : '', '展示给客户的中文标签，如"预约电话"', 40));

    // type
    host.appendChild(settingSelectField('类型', 'settingType',
        SETTING_TYPES.map(t => [t.id, t.name]),
        item ? item.type : 'text'));

    // value
    host.appendChild(settingTextField('内容', 'settingValue',
        item ? item.value : '', '将展示给客户的实际内容', 500));

    // icon
    host.appendChild(settingIconField('图标 (Font Awesome)', 'settingIcon',
        item ? item.icon : 'fa-circle-info'));

    // sort_order
    host.appendChild(settingNumberField('排序', 'settingSort',
        item ? item.sort_order : 100, '数字越小越靠前'));

    // 类型变化时刷新提示
    const typeSel = document.getElementById('settingType');
    const updateHint = () => {
        const meta = SETTING_TYPES.find(t => t.id === typeSel.value);
        document.getElementById('settingFieldHint').textContent =
            meta ? `校验规则：${meta.hint}` : '';
    };
    typeSel.addEventListener('change', updateHint);
    updateHint();

    const m = document.getElementById('settingModal');
    m.classList.remove('hidden'); m.classList.add('flex');
}

function closeSettingModal() {
    const m = document.getElementById('settingModal');
    m.classList.add('hidden'); m.classList.remove('flex');
    editingSetting = null;
}

function settingTextField(label, id, value, placeholder = '', maxLen = 80) {
    const w = document.createElement('div');
    const l = document.createElement('label');
    l.className = 'block text-sm font-medium text-gray-700 mb-1'; l.textContent = label;
    const i = document.createElement('input');
    i.id = id; i.type = 'text'; i.value = value || ''; i.maxLength = maxLen;
    i.placeholder = placeholder;
    i.className = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500';
    w.appendChild(l); w.appendChild(i);
    return w;
}
function settingNumberField(label, id, value, hint = '') {
    const w = document.createElement('div');
    const l = document.createElement('label');
    l.className = 'block text-sm font-medium text-gray-700 mb-1'; l.textContent = label;
    const i = document.createElement('input');
    i.id = id; i.type = 'number'; i.min = 0; i.max = 9999;
    i.value = (value === null || value === undefined) ? 100 : value;
    i.className = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500';
    w.appendChild(l); w.appendChild(i);
    if (hint) {
        const p = document.createElement('p');
        p.className = 'text-xs text-gray-400 mt-1'; p.textContent = hint;
        w.appendChild(p);
    }
    return w;
}
function settingSelectField(label, id, options, selected) {
    const w = document.createElement('div');
    const l = document.createElement('label');
    l.className = 'block text-sm font-medium text-gray-700 mb-1'; l.textContent = label;
    const s = document.createElement('select');
    s.id = id; s.className = 'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500';
    options.forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if (v === selected) o.selected = true;
        s.appendChild(o);
    });
    w.appendChild(l); w.appendChild(s);
    return w;
}
function settingIconField(label, id, value) {
    const w = document.createElement('div');
    const l = document.createElement('label');
    l.className = 'block text-sm font-medium text-gray-700 mb-1'; l.textContent = label;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3';
    const preview = document.createElement('span');
    preview.className = 'w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700';
    const inp = document.createElement('input');
    inp.id = id; inp.type = 'text'; inp.value = value || 'fa-circle-info';
    inp.placeholder = 'fa-phone-alt 或 fab fa-weixin';
    inp.maxLength = 40;
    inp.className = 'flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500';
    const updatePreview = () => {
        const v = (inp.value || '').trim();
        preview.innerHTML = '';
        const i = document.createElement('i');
        i.className = v.includes(' ') ? v : `fas ${v}`;
        preview.appendChild(i);
    };
    inp.addEventListener('input', updatePreview);
    updatePreview();
    row.appendChild(preview); row.appendChild(inp);
    w.appendChild(l); w.appendChild(row);

    // 常用图标快捷选择
    const quick = document.createElement('div');
    quick.className = 'mt-2 flex flex-wrap gap-1';
    COMMON_ICONS.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'px-2 py-1 text-xs border border-gray-200 rounded hover:bg-emerald-50 hover:border-emerald-300';
        b.title = c;
        const i = document.createElement('i');
        i.className = c.includes(' ') ? c : `fas ${c}`;
        b.appendChild(i);
        b.addEventListener('click', () => { inp.value = c; updatePreview(); });
        quick.appendChild(b);
    });
    w.appendChild(quick);
    return w;
}

async function confirmSettingSave() {
    const key = document.getElementById('settingKey').value.trim().toLowerCase();
    const label = document.getElementById('settingLabel').value.trim();
    const type = document.getElementById('settingType').value;
    const value = document.getElementById('settingValue').value.trim();
    const icon = document.getElementById('settingIcon').value.trim() || 'fa-circle-info';
    const sortOrder = parseInt(document.getElementById('settingSort').value, 10) || 100;

    // 客户端校验（与后端一致）
    if (!editingSetting) {
        if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) {
            showNotification('Key 只能包含小写字母/数字/下划线，必须以字母开头（2-40 位）', 'error');
            return;
        }
    }
    if (!label) { showNotification('显示标签不能为空', 'error'); return; }
    if (!value) { showNotification('内容不能为空', 'error'); return; }
    const valueErr = validateSettingValueClient(value, type);
    if (valueErr) { showNotification(valueErr, 'error'); return; }

    const btn = document.getElementById('confirmSettingBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
    try {
        let resp;
        if (editingSetting) {
            resp = await apiFetch(`/api/admin/settings/${encodeURIComponent(editingSetting.key)}`, {
                method: 'PUT',
                body: JSON.stringify({ value, label, type, icon, sort_order: sortOrder }),
            });
        } else {
            resp = await apiFetch('/api/admin/settings', {
                method: 'POST',
                body: JSON.stringify({ key, value, label, type, icon, sort_order: sortOrder }),
            });
        }
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification(editingSetting ? '更新成功' : '新增成功', 'success');
            closeSettingModal();
            await loadSettings();
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录') showNotification('保存失败', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
    }
}

function validateSettingValueClient(value, type) {
    const v = (value || '').trim();
    if (type === 'phone') {
        const c = v.replace(/\s/g, '');
        if (!/^(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|400-?\d{3}-?\d{4}|800-?\d{3}-?\d{4})$/.test(c))
            return '电话格式不正确（支持手机号 / 区号-座机 / 400 / 800）';
    } else if (type === 'wechat') {
        if (!/^[A-Za-z][A-Za-z0-9_-]{5,29}$/.test(v))
            return '微信号格式不正确（字母开头，6-30 位字母数字下划线连字符）';
    } else if (type === 'email') {
        if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v))
            return '邮箱格式不正确';
    } else if (type === 'url') {
        if (!/^https?:\/\/[^\s]{3,500}$/.test(v))
            return '链接必须以 http:// 或 https:// 开头';
    } else if (type === 'text') {
        if (!v) return '内容不能为空';
    }
    return null;
}

async function deleteSetting(item) {
    if (item.builtin) {
        showNotification('内置项不可删除（可清空内容禁用）', 'error');
        return;
    }
    if (!confirm(`确定要删除"${item.label}（${item.key}）"吗？`)) return;
    try {
        const resp = await apiFetch(`/api/admin/settings/${encodeURIComponent(item.key)}`, {
            method: 'DELETE',
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification('删除成功', 'success');
            await loadSettings();
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录') showNotification('删除失败', 'error');
    }
}

// ============================================================
// 服务项目管理
// ============================================================
const SVC_TAGS = [
    { id: 'hot',       label: '热门',     color: 'bg-rose-100 text-rose-700' },
    { id: 'new',       label: '新品',     color: 'bg-emerald-100 text-emerald-700' },
    { id: 'female',    label: '女士专享', color: 'bg-pink-100 text-pink-700' },
    { id: 'couple',    label: '情侣套餐', color: 'bg-violet-100 text-violet-700' },
    { id: 'recommend', label: '主推',     color: 'bg-amber-100 text-amber-700' },
];

const svcState = {
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 1,
    items: [],
    editing: null, // null = 新增，否则编辑
};

function initServicesAdmin() {
    // 填充分类下拉（使用合并后的 allCategories，含自定义）
    const catSel = document.getElementById('svcCategoryFilter');
    catSel.innerHTML = '<option value="">全部分类</option>';
    allCategories.forEach(c => {
        const o = document.createElement('option');
        o.value = c.id; o.textContent = c.name;
        catSel.appendChild(o);
    });

    // 填充标签下拉
    const tagSel = document.getElementById('svcTagFilter');
    if (tagSel) {
        tagSel.innerHTML = '<option value="">全部标签</option>';
        allTags.forEach(t => {
            const o = document.createElement('option');
            o.value = t.id; o.textContent = t.label;
            tagSel.appendChild(o);
        });
    }

    document.getElementById('svcSearchBtn').addEventListener('click', () => {
        svcState.page = 1; loadServices();
    });
    document.getElementById('svcSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') { svcState.page = 1; loadServices(); }
    });
    [catSel, document.getElementById('svcTagFilter'), document.getElementById('svcActiveFilter')]
        .forEach(el => el.addEventListener('change', () => { svcState.page = 1; loadServices(); }));

    document.getElementById('svcAddBtn').addEventListener('click', () => openServiceModal(null));

    document.getElementById('svcPrev').addEventListener('click', () => {
        if (svcState.page > 1) { svcState.page--; loadServices(); }
    });
    document.getElementById('svcNext').addEventListener('click', () => {
        if (svcState.page < svcState.totalPages) { svcState.page++; loadServices(); }
    });

    // 弹窗事件
    document.getElementById('closeSvcBtn').addEventListener('click', closeServiceModal);
    document.getElementById('cancelSvcBtn').addEventListener('click', closeServiceModal);
    document.getElementById('confirmSvcBtn').addEventListener('click', confirmServiceSave);
    document.getElementById('svcModal').addEventListener('click', e => {
        if (e.target.id === 'svcModal') closeServiceModal();
    });

    // 图片上传
    const fileInput = document.getElementById('svcImageFile');
    document.getElementById('svcImageUploadBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', onUploadImage);

    // URL 实时刷新预览
    document.getElementById('svcImage').addEventListener('input', e => {
        updateImagePreview(e.target.value);
    });

    // 初始化分类 Combobox & 标签 chip 区
    initCategoryCombo();
    renderTagChips();
}

// ============================================================
// 分类 / 标签 - 服务端权威源同步
// ============================================================

/**
 * 重新拉取分类与标签列表，并填充全局 allCategories / allTags。
 * 调用时机：
 * - 进入后台后（tryEnterApp）
 * - 新增/编辑/删除项目成功后（保证自定义分类/标签立即同步）
 * - 显式新增分类/标签后
 * 该函数与 /api/admin/meta 返回的 categories/tags 字段是同一权威源。
 */
async function reloadCategoriesAndTags() {
    try {
        const [catResp, tagResp] = await Promise.all([
            apiFetch('/api/admin/categories'),
            apiFetch('/api/admin/tags'),
        ]);
        const [catResult, tagResult] = await Promise.all([
            catResp.json(), tagResp.json(),
        ]);
        if (catResult.code === 0 && Array.isArray(catResult.data)) {
            META.categories = catResult.data;
            allCategories = catResult.data.map(c => ({
                id: c.id, name: c.name || c.id, icon: c.icon,
                builtin: !!c.builtin, sort_order: c.sort_order ?? 100,
                custom: !c.builtin,
            }));
        }
        if (tagResult.code === 0 && Array.isArray(tagResult.data)) {
            META.tags = tagResult.data;
            allTags = tagResult.data.map(t => ({
                id: t.id, label: t.label || t.id, color: t.color,
                builtin: !!t.builtin, sort_order: t.sort_order ?? 100,
                custom: !t.builtin,
            }));
        }
    } catch (e) {
        console.warn('刷新分类/标签失败', e);
    }
}

/**
 * 兼容旧调用：把 META.categories（来自 /api/admin/meta，已是权威源）映射到 allCategories / allTags。
 * 适用于初始化阶段，避免再发一次请求。
 */
function rebuildCustomCollections() {
    const cats = Array.isArray(META.categories) ? META.categories : [];
    allCategories = cats.map(c => ({
        id: c.id, name: c.name || c.id, icon: c.icon || 'fa-tag',
        builtin: !!c.builtin, sort_order: c.sort_order ?? 100,
        custom: !c.builtin,
    }));

    const tags = Array.isArray(META.tags) ? META.tags : [];
    if (tags.length) {
        allTags = tags.map(t => ({
            id: t.id, label: t.label || t.id, color: t.color,
            builtin: !!t.builtin, sort_order: t.sort_order ?? 100,
            custom: !t.builtin,
        }));
    } else {
        // META.tags 还没拉到时，先放内置 5 个垫底，避免界面空白
        allTags = SVC_TAGS.map(t => ({
            id: t.id, label: t.label, color: t.color, builtin: true, custom: false,
        }));
    }
}

// ============================================================
// 分类 Combobox
// ============================================================
const comboState = { open: false, activeIndex: -1, filtered: [] };

function initCategoryCombo() {
    const combo = document.getElementById('svcCategoryCombo');
    const toggle = document.getElementById('svcCategoryToggle');
    const panel = document.getElementById('svcCategoryPanel');
    const search = document.getElementById('svcCategorySearch');

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        comboState.open ? closeCategoryCombo() : openCategoryCombo();
    });

    search.addEventListener('input', () => renderCategoryList(search.value));
    search.addEventListener('keydown', (e) => {
        const items = comboState.filtered;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            comboState.activeIndex = Math.min(items.length - 1, comboState.activeIndex + 1);
            renderCategoryList(search.value, /*keepActive*/ true);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            comboState.activeIndex = Math.max(0, comboState.activeIndex - 1);
            renderCategoryList(search.value, true);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const q = search.value.trim();
            if (comboState.activeIndex >= 0 && items[comboState.activeIndex]) {
                selectCategory(items[comboState.activeIndex].id);
            } else if (q) {
                tryAddCustomCategory(q);
            }
        } else if (e.key === 'Escape') {
            closeCategoryCombo();
        }
    });

    // 点击"新增分类"行
    document.getElementById('svcCategoryAddRow').addEventListener('click', () => {
        tryAddCustomCategory(search.value.trim());
    });

    // 点击外部关闭
    document.addEventListener('click', (e) => {
        if (!comboState.open) return;
        if (!combo.contains(e.target)) closeCategoryCombo();
    });
}

function openCategoryCombo() {
    comboState.open = true;
    document.getElementById('svcCategoryCombo').classList.add('is-open');
    document.getElementById('svcCategoryPanel').classList.remove('hidden');
    const search = document.getElementById('svcCategorySearch');
    search.value = '';
    comboState.activeIndex = -1;
    renderCategoryList('');
    setTimeout(() => search.focus(), 0);
}

function closeCategoryCombo() {
    comboState.open = false;
    document.getElementById('svcCategoryCombo').classList.remove('is-open');
    document.getElementById('svcCategoryPanel').classList.add('hidden');
}

function renderCategoryList(keyword, keepActive = false) {
    const list = document.getElementById('svcCategoryList');
    const addRow = document.getElementById('svcCategoryAddRow');
    const addText = document.getElementById('svcCategoryAddText');
    const currentId = document.getElementById('svcCategory').value;

    const q = (keyword || '').trim().toLowerCase();
    const filtered = allCategories.filter(c =>
        !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
    );
    comboState.filtered = filtered;
    if (!keepActive) comboState.activeIndex = filtered.length ? 0 : -1;

    list.innerHTML = '';
    if (!filtered.length) {
        const li = document.createElement('li');
        li.className = 'is-empty';
        li.textContent = q ? '无匹配项' : '暂无分类';
        list.appendChild(li);
    } else {
        filtered.forEach((c, idx) => {
            const li = document.createElement('li');
            li.setAttribute('role', 'option');
            if (idx === comboState.activeIndex) li.classList.add('is-active');
            if (c.id === currentId) li.classList.add('is-selected');
            const name = document.createElement('span');
            name.textContent = c.name;
            li.appendChild(name);
            if (c.custom) {
                const badge = document.createElement('span');
                badge.className = 'badge-custom';
                badge.textContent = '自定义';
                li.appendChild(badge);
            }
            li.addEventListener('mouseenter', () => {
                comboState.activeIndex = idx;
                [...list.children].forEach(el => el.classList.remove('is-active'));
                li.classList.add('is-active');
            });
            li.addEventListener('click', () => selectCategory(c.id));
            list.appendChild(li);
        });
    }

    // "新增分类 xxx" 行：当 q 不为空且不与现有 name/id 完全匹配时显示
    const existed = q && allCategories.some(c =>
        c.name.toLowerCase() === q || c.id.toLowerCase() === q
    );
    if (q && !existed) {
        addRow.classList.remove('hidden');
        addText.textContent = q;
    } else {
        addRow.classList.add('hidden');
    }
}

function selectCategory(id) {
    const cat = allCategories.find(c => c.id === id);
    if (!cat) return;
    document.getElementById('svcCategory').value = cat.id;
    const label = document.getElementById('svcCategoryLabel');
    label.textContent = cat.name;
    label.classList.remove('text-gray-400');
    closeCategoryCombo();
}

function setSelectedCategoryById(id) {
    const cat = allCategories.find(c => c.id === id);
    const label = document.getElementById('svcCategoryLabel');
    document.getElementById('svcCategory').value = id || '';
    if (cat) {
        label.textContent = cat.name;
        label.classList.remove('text-gray-400');
    } else {
        label.textContent = '请选择';
        label.classList.add('text-gray-400');
    }
}

async function tryAddCustomCategory(rawName) {
    const name = (rawName || '').trim();
    if (!name) { showNotification('请输入分类名称', 'error'); return; }
    if (!CUSTOM_LABEL_RE.test(name)) {
        showNotification('分类名称仅支持中英文/数字/-_/空格，1-20 位', 'error');
        return;
    }
    // 已存在则直接选中
    const exist = allCategories.find(c =>
        c.name.toLowerCase() === name.toLowerCase() || c.id.toLowerCase() === name.toLowerCase()
    );
    if (exist) { selectCategory(exist.id); return; }

    // id 直接用名称本身（后端允许中英文 1-20 位）
    const id = name;
    try {
        const resp = await apiFetch('/api/admin/categories', {
            method: 'POST',
            body: JSON.stringify({ id, name, sort_order: 200 }),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            // 服务端权威源新增成功，刷新本地列表
            await reloadCategoriesAndTags();
            // 重新填充各处下拉
            fillFilterOptions();
            // Combobox 中的 currentId 也要保持
            selectCategory(id);
            // 通知所有页面（含客户端）
            notifyServiceChanged('category');
            showNotification(`已新增分类「${name}」`, 'success');
        } else if (resp.status === 409) {
            // 服务端已存在 → 拉一次后再选中
            await reloadCategoriesAndTags();
            selectCategory(id);
            showNotification('该分类已存在，已自动选中', 'info');
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        console.error('新增分类失败:', e);
        showNotification('新增分类失败：' + (e.message || '网络异常'), 'error');
    }
}

// ============================================================
// 标签 chips
// ============================================================
let _tagAddingMode = false; // 是否处于"新增标签"输入态

function renderTagChips(selectedTags) {
    const wrap = document.getElementById('svcTags');
    const previouslyChecked = selectedTags || readSelectedTags();
    wrap.innerHTML = '';

    allTags.forEach(t => {
        const chip = document.createElement('label');
        const isBuiltin = BUILTIN_TAG_IDS.has(t.id);
        chip.className = `svc-tag-chip ${isBuiltin && t.color ? t.color : ''} ${t.custom ? 'is-custom' : ''}`.trim();

        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = t.id; cb.dataset.tag = '1';
        cb.className = 'mr-1';
        cb.checked = previouslyChecked.includes(t.id);

        const span = document.createElement('span');
        span.textContent = t.label;

        chip.appendChild(cb); chip.appendChild(span);

        if (t.custom) {
            const rm = document.createElement('span');
            rm.className = 'chip-remove';
            rm.title = '移除该标签';
            rm.innerHTML = '<i class="fas fa-times"></i>';
            rm.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                removeCustomTag(t.id);
            });
            chip.appendChild(rm);
        }
        wrap.appendChild(chip);
    });

    // "+ 新增标签"：未处于输入态显示按钮，输入态显示行内输入框
    if (_tagAddingMode) {
        const editor = document.createElement('span');
        editor.className = 'svc-tag-add-editor';
        const input = document.createElement('input');
        input.type = 'text'; input.maxLength = 20;
        input.placeholder = '输入标签名（回车确认）';
        const ok = document.createElement('button');
        ok.type = 'button'; ok.className = 'svc-tag-add-ok';
        ok.innerHTML = '<i class="fas fa-check"></i>';
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'svc-tag-add-cancel';
        cancel.innerHTML = '<i class="fas fa-times"></i>';

        const submit = () => commitCustomTag(input.value);
        ok.addEventListener('click', submit);
        cancel.addEventListener('click', () => { _tagAddingMode = false; renderTagChips(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { _tagAddingMode = false; renderTagChips(); }
        });

        editor.appendChild(input); editor.appendChild(ok); editor.appendChild(cancel);
        wrap.appendChild(editor);
        setTimeout(() => input.focus(), 0);
    } else {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'svc-tag-add';
        addBtn.innerHTML = '<i class="fas fa-plus"></i><span>新增标签</span>';
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            _tagAddingMode = true;
            renderTagChips();
        });
        wrap.appendChild(addBtn);
    }
}

async function commitCustomTag(rawName) {
    const name = (rawName || '').trim();
    if (!name) { showNotification('请输入标签名称', 'error'); return; }
    if (!CUSTOM_LABEL_RE.test(name)) {
        showNotification('标签名称仅支持中英文/数字/-_/空格，1-20 位', 'error');
        return;
    }
    const exist = allTags.find(t =>
        t.label.toLowerCase() === name.toLowerCase() || t.id.toLowerCase() === name.toLowerCase()
    );
    if (exist) {
        const current = readSelectedTags();
        if (!current.includes(exist.id)) current.push(exist.id);
        _tagAddingMode = false;
        renderTagChips(current);
        showNotification('已存在同名标签，已自动选中', 'info');
        return;
    }
    // id 直接用名称本身
    const id = name;
    try {
        const resp = await apiFetch('/api/admin/tags', {
            method: 'POST',
            body: JSON.stringify({ id, label: name, color: 'bg-slate-500', sort_order: 200 }),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            // 刷新权威源
            await reloadCategoriesAndTags();
            // 同步到下拉与 chips
            fillFilterOptions();
            const current = readSelectedTags();
            current.push(id);
            _tagAddingMode = false;
            renderTagChips(current);
            notifyServiceChanged('tag');
            showNotification(`已新增标签「${name}」`, 'success');
        } else if (resp.status === 409) {
            await reloadCategoriesAndTags();
            const current = readSelectedTags();
            if (!current.includes(id)) current.push(id);
            _tagAddingMode = false;
            renderTagChips(current);
            showNotification('该标签已存在，已自动选中', 'info');
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        console.error('新增标签失败:', e);
        showNotification('新增标签失败：' + (e.message || '网络异常'), 'error');
    }
}

async function removeCustomTag(id) {
    if (!confirm('确定移除该自定义标签？\n（如该标签仍被服务项目使用将拒绝删除；可在确认后强制删除，强制删除不会改动已使用项目里的 tag 字符串。）')) return;
    try {
        // 先尝试普通删除
        let resp = await apiFetch(`/api/admin/tags/${encodeURIComponent(id)}`, { method: 'DELETE' });
        let result = await resp.json();
        if (!resp.ok && resp.status === 400 && /仍被/.test(result.detail || '')) {
            if (!confirm((result.detail || '该标签仍在使用中。') + '\n\n是否强制删除？')) return;
            resp = await apiFetch(`/api/admin/tags/${encodeURIComponent(id)}?force=1`, { method: 'DELETE' });
            result = await resp.json();
        }
        if (resp.ok && result.code === 0) {
            await reloadCategoriesAndTags();
            fillFilterOptions();
            const current = readSelectedTags().filter(v => v !== id);
            renderTagChips(current);
            notifyServiceChanged('tag');
            showNotification('已删除标签', 'success');
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        console.error('删除标签失败:', e);
        showNotification('删除标签失败：' + (e.message || '网络异常'), 'error');
    }
}

async function loadServices() {
    const params = new URLSearchParams();
    params.set('page', svcState.page);
    params.set('page_size', svcState.pageSize);
    const cat = document.getElementById('svcCategoryFilter').value;
    const tag = document.getElementById('svcTagFilter').value;
    const active = document.getElementById('svcActiveFilter').value;
    const kw = document.getElementById('svcSearch').value.trim();
    if (cat) params.set('category', cat);
    if (tag) params.set('tag', tag);
    if (active !== '') params.set('is_active', active);
    if (kw) params.set('keyword', kw);

    try {
        const resp = await apiFetch(`/api/admin/services?${params}`);
        const result = await resp.json();
        if (result.code === 0) {
            svcState.items = result.data.items;
            svcState.total = result.data.total;
            svcState.totalPages = result.data.total_pages;
            renderServiceTable();
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录') {
            console.error('加载服务列表失败:', e);
            showNotification('加载服务列表失败', 'error');
        }
    }
}

function renderServiceTable() {
    const tbody = document.getElementById('svcTableBody');
    const wrap = document.getElementById('svcTableWrap');
    const empty = document.getElementById('svcEmpty');
    const pag = document.getElementById('svcPagination');
    tbody.innerHTML = '';
    if (!svcState.items.length) {
        wrap.classList.add('hidden');
        empty.classList.remove('hidden');
        pag.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    empty.classList.add('hidden');

    svcState.items.forEach(item => {
        const tr = document.createElement('tr');
        tr.className = 'animate-fade-in hover:bg-gray-50';

        const tdImg = document.createElement('td');
        tdImg.className = 'px-4 py-3';
        const img = document.createElement('img');
        img.src = item.image; img.alt = item.name;
        img.className = 'w-16 h-12 object-cover rounded border border-gray-200';
        img.onerror = () => { img.style.display = 'none'; };
        tdImg.appendChild(img);
        tr.appendChild(tdImg);

        const tdId = document.createElement('td');
        tdId.className = 'px-4 py-3 text-sm';
        const code = document.createElement('code');
        code.className = 'bg-gray-100 px-2 py-1 rounded text-xs';
        code.textContent = item.id;
        tdId.appendChild(code);
        tr.appendChild(tdId);

        const tdName = document.createElement('td');
        tdName.className = 'px-4 py-3 text-sm';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'font-medium text-gray-900';
        nameDiv.textContent = item.name;
        const subDiv = document.createElement('div');
        subDiv.className = 'text-xs text-gray-500';
        subDiv.textContent = item.subtitle || '';
        tdName.appendChild(nameDiv); tdName.appendChild(subDiv);
        tr.appendChild(tdName);

        tr.appendChild(cell(idToName(allCategories, item.category)));
        tr.appendChild(cell(`${item.duration} 分钟`));

        const tdPrice = document.createElement('td');
        tdPrice.className = 'px-4 py-3 text-sm';
        const cur = document.createElement('div');
        cur.className = 'font-bold text-emerald-700';
        cur.textContent = `¥${item.price}`;
        tdPrice.appendChild(cur);
        if (item.original_price && item.original_price > item.price) {
            const orig = document.createElement('div');
            orig.className = 'text-xs text-gray-400 line-through';
            orig.textContent = `¥${item.original_price}`;
            tdPrice.appendChild(orig);
        }
        tr.appendChild(tdPrice);

        const tdTags = document.createElement('td');
        tdTags.className = 'px-4 py-3 text-xs';
        (item.tags || []).forEach(t => {
            const builtin = SVC_TAGS.find(x => x.id === t);
            const custom = !builtin ? allTags.find(x => x.id === t) : null;
            const span = document.createElement('span');
            span.className = `inline-block px-2 py-0.5 rounded mr-1 mb-1 ${builtin ? builtin.color : 'bg-slate-100 text-slate-700'}`;
            span.textContent = builtin ? builtin.label : (custom ? custom.label : t);
            tdTags.appendChild(span);
        });
        tr.appendChild(tdTags);

        const tdCreated = document.createElement('td');
        tdCreated.className = 'px-4 py-3 text-sm text-gray-600 whitespace-nowrap';
        tdCreated.textContent = formatDateTime(item.created_at);
        tr.appendChild(tdCreated);

        const tdActive = document.createElement('td');
        tdActive.className = 'px-4 py-3';
        const badge = document.createElement('span');
        badge.className = item.is_active
            ? 'status-badge bg-emerald-100 text-emerald-800'
            : 'status-badge bg-gray-200 text-gray-600';
        badge.textContent = item.is_active ? '已上架' : '已下架';
        tdActive.appendChild(badge);
        tr.appendChild(tdActive);

        const tdOp = document.createElement('td');
        tdOp.className = 'px-4 py-3 text-sm font-medium space-x-2 whitespace-nowrap';
        const editBtn = document.createElement('button');
        editBtn.className = 'text-emerald-600 hover:text-emerald-900';
        editBtn.innerHTML = '<i class="fas fa-pen-to-square"></i> 编辑';
        editBtn.addEventListener('click', () => openServiceModal(item));
        const delBtn = document.createElement('button');
        delBtn.className = 'text-rose-600 hover:text-rose-900';
        delBtn.innerHTML = '<i class="fas fa-trash"></i> 删除';
        delBtn.addEventListener('click', () => deleteService(item));
        tdOp.appendChild(editBtn); tdOp.appendChild(delBtn);
        tr.appendChild(tdOp);

        tbody.appendChild(tr);
    });

    // 分页
    document.getElementById('svcTotal').textContent = svcState.total;
    document.getElementById('svcPageInfo').textContent = `第 ${svcState.page} / ${svcState.totalPages} 页`;
    document.getElementById('svcPrev').disabled = svcState.page <= 1;
    document.getElementById('svcNext').disabled = svcState.page >= svcState.totalPages;
    pag.classList.remove('hidden');
}

function openServiceModal(item) {
    try {
        svcState.editing = item;
        document.getElementById('svcModalTitle').textContent = item ? '编辑服务项目' : '新增服务项目';
        const idInput = document.getElementById('svcId');
        idInput.value = item ? item.id : '';
        idInput.disabled = !!item;
        document.getElementById('svcName').value = item ? item.name : '';
        document.getElementById('svcSubtitle').value = item ? (item.subtitle || '') : '';
        document.getElementById('svcImage').value = item ? (item.image || '') : '';
        document.getElementById('svcDuration').value = item ? item.duration : 60;
        document.getElementById('svcPrice').value = item ? item.price : 198;
        document.getElementById('svcOriginalPrice').value = item ? (item.original_price || 0) : 0;
        document.getElementById('svcPopularity').value = item ? (item.popularity ?? 50) : 50;
        document.getElementById('svcEffects').value = item ? (item.effects || []).join('\n') : '';
        document.getElementById('svcSuitableFor').value = item ? (item.suitable_for || '') : '';
        document.getElementById('svcDescription').value = item ? (item.description || '') : '';
        document.getElementById('svcContactPhone').value = item ? (item.contact_phone || '') : '';
        document.getElementById('svcSortOrder').value = item ? (item.sort_order ?? 100) : 100;
        document.getElementById('svcIsActive').checked = item ? !!item.is_active : true;

        // 分类：若 item.category 不在 allCategories 中（来自其它入口的历史值），临时合并
        const catId = item ? item.category : '';
        if (catId && !allCategories.find(c => c.id === catId)) {
            allCategories.push({ id: catId, name: catId, custom: true });
        }
        setSelectedCategoryById(catId);
        closeCategoryCombo();

        // 标签：合并 item.tags 中不存在的项
        const tags = (item && Array.isArray(item.tags)) ? item.tags.slice() : [];
        tags.forEach(t => {
            if (!allTags.find(x => x.id === t)) {
                allTags.push({ id: t, label: t, custom: true });
            }
        });
        _tagAddingMode = false;
        renderTagChips(tags);

        updateImagePreview(item ? item.image : '');
        document.getElementById('svcImageFile').value = '';

        const m = document.getElementById('svcModal');
        m.classList.remove('hidden'); m.classList.add('flex');
    } catch (err) {
        console.error('打开服务项目弹窗失败:', err);
        showNotification(`打开弹窗失败：${err.message || err}`, 'error');
    }
}

function closeServiceModal() {
    const m = document.getElementById('svcModal');
    m.classList.add('hidden'); m.classList.remove('flex');
    svcState.editing = null;
}

function updateImagePreview(url) {
    const wrap = document.getElementById('svcImagePreview');
    wrap.innerHTML = '';
    if (!url) {
        wrap.innerHTML = '<i class="fas fa-image text-3xl text-gray-300"></i>';
        return;
    }
    const img = document.createElement('img');
    img.src = url;
    img.className = 'w-full h-full object-cover';
    img.onerror = () => {
        wrap.innerHTML = '<i class="fas fa-triangle-exclamation text-3xl text-amber-400"></i>';
    };
    wrap.appendChild(img);
}

async function onUploadImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        showNotification('图片大小不能超过 5MB', 'error');
        e.target.value = '';
        return;
    }
    if (!/^image\/(jpe?g|png|webp|gif)$/i.test(file.type)) {
        showNotification('仅支持 jpg / png / webp / gif 格式', 'error');
        e.target.value = '';
        return;
    }

    const btn = document.getElementById('svcImageUploadBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>上传中...';
    try {
        const formData = new FormData();
        formData.append('file', file);
        const token = getToken();
        const resp = await fetch('/api/admin/upload/image', {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: formData,
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            const url = result.data.url;
            document.getElementById('svcImage').value = url;
            updateImagePreview(url);
            showNotification('上传成功', 'success');
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (err) {
        console.error('上传失败:', err);
        showNotification('上传失败，请稍后重试', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
        e.target.value = '';
    }
}

function readSelectedTags() {
    return [...document.querySelectorAll('#svcTags input[data-tag]:checked')].map(c => c.value);
}

function readEffects() {
    const raw = document.getElementById('svcEffects').value || '';
    return raw.split(/[\n,，;；]/).map(s => s.trim()).filter(Boolean).slice(0, 10);
}

async function confirmServiceSave() {
    const isEdit = !!svcState.editing;
    const id = document.getElementById('svcId').value.trim();
    const name = document.getElementById('svcName').value.trim();
    const subtitle = document.getElementById('svcSubtitle').value.trim();
    const category = document.getElementById('svcCategory').value;
    const image = document.getElementById('svcImage').value.trim();
    const duration = parseInt(document.getElementById('svcDuration').value, 10);
    const price = parseInt(document.getElementById('svcPrice').value, 10);
    const originalPrice = parseInt(document.getElementById('svcOriginalPrice').value, 10) || 0;
    const popularity = parseInt(document.getElementById('svcPopularity').value, 10) || 0;
    const tags = readSelectedTags();
    const effects = readEffects();
    const suitableFor = document.getElementById('svcSuitableFor').value.trim();
    const description = document.getElementById('svcDescription').value.trim();
    const contactPhone = document.getElementById('svcContactPhone').value.trim();
    const sortOrder = parseInt(document.getElementById('svcSortOrder').value, 10) || 100;
    const isActive = document.getElementById('svcIsActive').checked;

    // 客户端校验（与后端一致）
    if (!isEdit) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/.test(id)) {
            showNotification('ID 必须以字母开头，2-40 位字母数字下划线连字符', 'error');
            return;
        }
    }
    if (!name) { showNotification('项目名称不能为空', 'error'); return; }
    if (!category) { showNotification('请选择分类', 'error'); return; }
    if (!image) { showNotification('请上传或填写封面图片', 'error'); return; }
    if (!Number.isFinite(duration) || duration < 10 || duration > 300) {
        showNotification('时长必须在 10-300 分钟之间', 'error'); return;
    }
    if (!Number.isFinite(price) || price < 1 || price > 99999) {
        showNotification('现价必须在 1-99999 之间', 'error'); return;
    }
    if (originalPrice && originalPrice < price) {
        showNotification('原价不能低于现价', 'error'); return;
    }
    if (contactPhone) {
        const phoneErr = validateSettingValueClient(contactPhone, 'phone');
        if (phoneErr) { showNotification(phoneErr, 'error'); return; }
    }

    const payload = {
        name, subtitle, category, image,
        duration, price, original_price: originalPrice,
        popularity, tags, effects,
        suitable_for: suitableFor, description,
        contact_phone: contactPhone,
        is_active: isActive,
        sort_order: sortOrder,
    };
    if (!isEdit) payload.id = id;

    const btn = document.getElementById('confirmSvcBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
    try {
        let resp;
        if (isEdit) {
            resp = await apiFetch(`/api/admin/services/${encodeURIComponent(svcState.editing.id)}`, {
                method: 'PUT', body: JSON.stringify(payload),
            });
        } else {
            resp = await apiFetch('/api/admin/services', {
                method: 'POST', body: JSON.stringify(payload),
            });
        }
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification(isEdit ? '更新成功' : '新增成功', 'success');
            closeServiceModal();
            // 刷新分类/标签权威源（新分类/新标签后端已自动 upsert，这里同步到本地）
            await reloadCategoriesAndTags();
            fillFilterOptions();
            await loadServices();
            // 通知所有同源页面（含客户端）：服务/分类/标签发生变化，立即刷新
            notifyServiceChanged('service');
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录') showNotification('保存失败', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
    }
}

async function deleteService(item) {
    if (!confirm(`确定要删除项目"${item.name}（${item.id}）"吗？删除后客户端将不再展示。`)) return;
    try {
        const resp = await apiFetch(`/api/admin/services/${encodeURIComponent(item.id)}`, {
            method: 'DELETE',
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification('删除成功', 'success');
            await loadServices();
            // 通知所有同源页面：项目变化，立即刷新
            notifyServiceChanged('service');
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录') showNotification('删除失败', 'error');
    }
}


// ============================================================
// 优惠活动管理（CRUD）
// ============================================================
let OFFERS_LIST = [];
let editingOfferId = null;

const ALLOWED_OFFER_THEMES_FE = new Set([
    'offer-1', 'offer-2', 'offer-3', 'offer-4',
    'offer-5', 'offer-6', 'offer-7', 'offer-8',
    'offer-9', 'offer-10', 'offer-11', 'offer-12',
]);
// 主题中文标签（用于列表展示）
const OFFER_THEME_LABELS = {
    'offer-1':  '绿松石',
    'offer-2':  '琥珀金',
    'offer-3':  '紫粉',
    'offer-4':  '鼠尾草',
    'offer-5':  '暮霞橙',
    'offer-6':  '海湾蓝',
    'offer-7':  '樱花粉',
    'offer-8':  '玉墨',
    'offer-9':  '蜜桃乳',
    'offer-10': '薄荷青',
    'offer-11': '紫晶',
    'offer-12': '暖阳金',
};

function escHtmlOffer(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function loadOffers() {
    try {
        const resp = await apiFetch('/api/admin/offers');
        if (!resp.ok) {
            const err = await readApiJson(resp).catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        const result = await readApiJson(resp);
        OFFERS_LIST = Array.isArray(result.data) ? result.data : [];
        renderOffersTable();
        renderOffersPreview();
        // 拉到优惠数据后，本地合并 META.sources（基础 6 项 + 上架优惠 offer_key），
        // 立即刷新顶部"来源/套餐"筛选下拉。新增/修改/删除/上下架后均经此路径同步。
        try { rebuildMetaSourcesFromOffers(); } catch (err) { console.warn(err); }
    } catch (e) {
        console.error('加载优惠活动失败:', e);
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('加载优惠活动失败：' + (e.message || '未知错误'), 'error');
        }
    }
}

/** 基础来源（与后端 BUILTIN_BOOKING_SOURCES 保持一致） */
const BASE_BOOKING_SOURCES = [
    { id: 'normal',         name: '普通预约' },
    { id: 'new_customer',   name: '新客体验价' },
    { id: 'member',         name: '会员套餐' },
    { id: 'couple_package', name: '双人套餐' },
    { id: 'flash_sale',     name: '限时秒杀' },
    { id: 'promo',          name: '优惠抢购' },
];

/**
 * 用最新的 OFFERS_LIST 重建 META.sources，并刷新顶部"来源/套餐"下拉。
 * 仅展示已上架的优惠（与后端 _build_meta_sources(active_only=True) 行为一致）。
 */
function rebuildMetaSourcesFromOffers() {
    if (!Array.isArray(OFFERS_LIST)) return;
    const seen = new Set(BASE_BOOKING_SOURCES.map(s => s.id));
    const merged = BASE_BOOKING_SOURCES.slice();
    OFFERS_LIST
        .filter(o => o && o.is_active && o.offer_key && o.name)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.id - b.id))
        .forEach(o => {
            const key = String(o.offer_key).trim();
            if (!key || seen.has(key)) return;
            seen.add(key);
            merged.push({ id: key, name: String(o.name).trim() });
        });
    if (typeof META === 'object' && META) {
        META.sources = merged;
    }
    refreshSourceFilter();
}

function renderOffersPreview() {
    const grid = document.getElementById('offerPreviewGrid');
    if (!grid) return;
    if (!OFFERS_LIST.length) {
        grid.innerHTML = `<div class="col-span-full text-center text-gray-400 py-6">
            <i class="fas fa-tags text-3xl"></i>
            <p class="mt-2 text-sm">暂无优惠活动</p>
        </div>`;
        return;
    }
    grid.innerHTML = OFFERS_LIST.map(o => offerPreviewHTML(o)).join('');
}

function offerPreviewHTML(o) {
    const theme = ALLOWED_OFFER_THEMES_FE.has(o.theme) ? o.theme : 'offer-1';
    const icon = (o.icon || 'fa-gift').trim();
    const features = Array.isArray(o.features) ? o.features : [];
    const cmpLine = [o.original_price, o.price_suffix].filter(Boolean).join(' · ');
    const inactive = !o.is_active;
    return `
        <div class="offer-preview ${theme} ${inactive ? 'is-inactive' : ''}">
            ${inactive ? '<span class="inactive-badge"><i class="fas fa-eye-slash mr-1"></i>已下架</span>' : ''}
            <i class="fas ${escHtmlOffer(icon)} icon"></i>
            <h3>${escHtmlOffer(o.name || '')}</h3>
            <div class="price-big">${escHtmlOffer(o.price || '')}</div>
            <div class="price-cmp">${escHtmlOffer(cmpLine)}</div>
            <ul>${features.map(f => `<li><i class="fas fa-check"></i> ${escHtmlOffer(f)}</li>`).join('')}</ul>
            <div class="offer-btn-mock">${escHtmlOffer(o.btn_text || '立即预约')}</div>
        </div>
    `;
}

function renderOffersTable() {
    const tbody = document.getElementById('offerTableBody');
    const empty = document.getElementById('offerEmpty');
    const wrap = document.getElementById('offerTableWrap');
    if (!tbody || !empty || !wrap) return;

    if (!OFFERS_LIST.length) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        wrap.classList.add('hidden');
        return;
    }
    empty.classList.add('hidden');
    wrap.classList.remove('hidden');

    const sourceLabelMap = {
        new_customer: '新客体验价', member: '会员套餐',
        couple_package: '双人套餐', flash_sale: '限时秒杀',
        promo: '优惠抢购', normal: '普通预约',
    };

    tbody.innerHTML = OFFERS_LIST.map(o => {
        const theme = ALLOWED_OFFER_THEMES_FE.has(o.theme) ? o.theme : 'offer-1';
        const themeLabel = OFFER_THEME_LABELS[theme] || theme;
        const cmp = o.original_price || '-';
        const suffix = o.price_suffix ? `<div class="text-xs text-gray-400">${escHtmlOffer(o.price_suffix)}</div>` : '';
        const statusBadge = o.is_active
            ? '<span class="px-2 py-0.5 text-xs rounded-full bg-emerald-100 text-emerald-700"><i class="fas fa-check-circle mr-1"></i>已上架</span>'
            : '<span class="px-2 py-0.5 text-xs rounded-full bg-gray-200 text-gray-600"><i class="fas fa-eye-slash mr-1"></i>已下架</span>';
        return `
            <tr>
                <td class="px-4 py-3 text-gray-700">${o.sort_order ?? 100}</td>
                <td class="px-4 py-3 text-gray-700"><i class="fas ${escHtmlOffer(o.icon || 'fa-gift')} text-rose-500"></i></td>
                <td class="px-4 py-3">
                    <div class="font-medium text-gray-800">${escHtmlOffer(o.name || '')}</div>
                    <div class="text-xs text-gray-400 mt-0.5">${escHtmlOffer(o.offer_key || '')}</div>
                </td>
                <td class="px-4 py-3 text-gray-800 font-semibold">${escHtmlOffer(o.price || '-')}</td>
                <td class="px-4 py-3 text-gray-600">
                    ${escHtmlOffer(cmp)}
                    ${suffix}
                </td>
                <td class="px-4 py-3 text-xs text-gray-600">${themeLabel}</td>
                <td class="px-4 py-3 text-xs text-gray-600">${escHtmlOffer(sourceLabelMap[o.source] || o.source || '-')}</td>
                <td class="px-4 py-3 text-xs text-gray-600">${escHtmlOffer(o.btn_text || '立即预约')}</td>
                <td class="px-4 py-3">${statusBadge}</td>
                <td class="px-4 py-3">
                    <div class="flex gap-2">
                        <button class="text-blue-600 hover:underline text-sm" data-offer-edit="${o.id}">
                            <i class="fas fa-pen"></i> 编辑
                        </button>
                        <button class="text-${o.is_active ? 'amber' : 'emerald'}-600 hover:underline text-sm" data-offer-toggle="${o.id}">
                            <i class="fas fa-${o.is_active ? 'eye-slash' : 'eye'}"></i> ${o.is_active ? '下架' : '上架'}
                        </button>
                        <button class="text-rose-600 hover:underline text-sm" data-offer-delete="${o.id}">
                            <i class="fas fa-trash"></i> 删除
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function openOfferModal(offer) {
    editingOfferId = offer ? offer.id : null;
    document.getElementById('offerModalTitle').textContent = offer ? '编辑优惠活动' : '新增优惠活动';
    document.getElementById('offerId').value = offer ? offer.id : '';
    const keyInput = document.getElementById('offerKey');
    keyInput.value = offer ? (offer.offer_key || '') : '';
    keyInput.disabled = !!offer;  // 编辑时不允许改 key
    document.getElementById('offerName').value = offer ? (offer.name || '') : '';
    document.getElementById('offerIcon').value = offer ? (offer.icon || 'fa-gift') : 'fa-gift';
    document.getElementById('offerTheme').value = offer ? (offer.theme || 'offer-1') : 'offer-1';
    document.getElementById('offerSource').value = offer ? (offer.source || 'promo') : 'promo';
    document.getElementById('offerPrice').value = offer ? (offer.price || '') : '';
    document.getElementById('offerOriginalPrice').value = offer ? (offer.original_price || '') : '';
    document.getElementById('offerPriceSuffix').value = offer ? (offer.price_suffix || '') : '';
    const features = offer && Array.isArray(offer.features) ? offer.features : [];
    document.getElementById('offerFeatures').value = features.join('\n');
    document.getElementById('offerBtnText').value = offer ? (offer.btn_text || '立即预约') : '立即预约';
    document.getElementById('offerSortOrder').value = offer ? (offer.sort_order ?? 100) : 100;
    document.getElementById('offerIsActive').checked = offer ? !!offer.is_active : true;

    updateOfferLivePreview();

    const modal = document.getElementById('offerModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeOfferModal() {
    const modal = document.getElementById('offerModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    editingOfferId = null;
}

function readOfferForm() {
    const features = (document.getElementById('offerFeatures').value || '')
        .split('\n').map(s => s.trim()).filter(Boolean);
    return {
        offer_key: (document.getElementById('offerKey').value || '').trim().toLowerCase(),
        name: (document.getElementById('offerName').value || '').trim(),
        icon: (document.getElementById('offerIcon').value || 'fa-gift').trim() || 'fa-gift',
        theme: document.getElementById('offerTheme').value || 'offer-1',
        source: document.getElementById('offerSource').value || 'promo',
        price: (document.getElementById('offerPrice').value || '').trim(),
        original_price: (document.getElementById('offerOriginalPrice').value || '').trim(),
        price_suffix: (document.getElementById('offerPriceSuffix').value || '').trim(),
        features,
        btn_text: (document.getElementById('offerBtnText').value || '立即预约').trim() || '立即预约',
        sort_order: parseInt(document.getElementById('offerSortOrder').value, 10) || 100,
        is_active: document.getElementById('offerIsActive').checked,
    };
}

function updateOfferLivePreview() {
    const data = readOfferForm();
    const preview = document.getElementById('offerLivePreview');
    if (!preview) return;
    preview.innerHTML = offerPreviewHTML(data);
}

async function submitOffer() {
    const data = readOfferForm();

    // 前端校验
    if (!editingOfferId) {
        if (!/^[a-z][a-z0-9_]{1,39}$/.test(data.offer_key)) {
            showNotification('活动 Key 格式错误（小写字母开头，2-40 位字母数字下划线）', 'error');
            return;
        }
    }
    if (!data.name) { showNotification('请填写活动名称', 'error'); return; }
    if (!data.price) { showNotification('请填写主价格', 'error'); return; }
    if (data.features.length > 8) { showNotification('卖点最多 8 条', 'error'); return; }
    if (data.features.some(f => f.length > 60)) { showNotification('每条卖点不能超过 60 字', 'error'); return; }
    if (!ALLOWED_OFFER_THEMES_FE.has(data.theme)) { showNotification('主题不合法', 'error'); return; }

    const btn = document.getElementById('confirmOfferBtn');
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';

    try {
        let resp;
        if (editingOfferId) {
            const payload = { ...data };
            delete payload.offer_key;  // 编辑时不传 offer_key
            resp = await apiFetch(`/api/admin/offers/${editingOfferId}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
        } else {
            resp = await apiFetch('/api/admin/offers', {
                method: 'POST',
                body: JSON.stringify(data),
            });
        }
        const result = await readApiJson(resp);
        if (resp.ok && result.code === 0) {
            showNotification(editingOfferId ? '更新成功' : '新增成功', 'success');
            closeOfferModal();
            await loadOffers();
            // loadOffers 内部已自动重建 META.sources 并刷新筛选下拉
            // 通知首页刷新（同源 storage 事件）
            try { localStorage.setItem('yx_offers_updated', String(Date.now())); } catch {}
            try { notifyServiceChanged && notifyServiceChanged('offer'); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('保存失败：' + (e.message || '网络错误'), 'error');
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
}

async function toggleOfferActive(id) {
    const o = OFFERS_LIST.find(x => x.id === id);
    if (!o) return;
    try {
        const resp = await apiFetch(`/api/admin/offers/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ is_active: !o.is_active }),
        });
        const result = await readApiJson(resp);
        if (resp.ok && result.code === 0) {
            showNotification(!o.is_active ? '已上架' : '已下架', 'success');
            await loadOffers();
            // loadOffers 内部已自动重建 META.sources 并刷新筛选下拉
            try { localStorage.setItem('yx_offers_updated', String(Date.now())); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('操作失败', 'error');
        }
    }
}

async function deleteOffer(id) {
    const o = OFFERS_LIST.find(x => x.id === id);
    if (!o) return;
    if (!confirm(`确定要删除优惠活动「${o.name}」吗？此操作不可撤销。`)) return;
    try {
        const resp = await apiFetch(`/api/admin/offers/${id}`, { method: 'DELETE' });
        const result = await readApiJson(resp);
        if (resp.ok && result.code === 0) {
            showNotification('删除成功', 'success');
            await loadOffers();
            // loadOffers 内部已自动重建 META.sources 并刷新筛选下拉
            try { localStorage.setItem('yx_offers_updated', String(Date.now())); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('删除失败', 'error');
        }
    }
}

// ---------------- 事件绑定 ----------------
function initOfferEvents() {
    const addBtn = document.getElementById('offerAddBtn');
    const refreshBtn = document.getElementById('offerRefreshBtn');
    const modal = document.getElementById('offerModal');
    if (!addBtn || !modal) return;

    const closeBtn = document.getElementById('closeOfferBtn');
    const cancelBtn = document.getElementById('cancelOfferBtn');
    const confirmBtn = document.getElementById('confirmOfferBtn');
    const tbody = document.getElementById('offerTableBody');

    addBtn.addEventListener('click', () => openOfferModal(null));
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadOffers());
    closeBtn.addEventListener('click', closeOfferModal);
    cancelBtn.addEventListener('click', closeOfferModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeOfferModal(); });
    confirmBtn.addEventListener('click', submitOffer);

    // 表单输入实时刷新预览
    const previewInputs = [
        'offerName', 'offerIcon', 'offerTheme', 'offerPrice',
        'offerOriginalPrice', 'offerPriceSuffix', 'offerFeatures',
        'offerBtnText', 'offerIsActive',
    ];
    previewInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updateOfferLivePreview);
            el.addEventListener('change', updateOfferLivePreview);
        }
    });

    // 表格内的编辑/上下架/删除按钮事件委托
    if (tbody) {
        tbody.addEventListener('click', (e) => {
            const editBtn = e.target.closest('[data-offer-edit]');
            const toggleBtn = e.target.closest('[data-offer-toggle]');
            const delBtn = e.target.closest('[data-offer-delete]');
            if (editBtn) {
                const id = parseInt(editBtn.getAttribute('data-offer-edit'), 10);
                const o = OFFERS_LIST.find(x => x.id === id);
                if (o) openOfferModal(o);
            } else if (toggleBtn) {
                const id = parseInt(toggleBtn.getAttribute('data-offer-toggle'), 10);
                toggleOfferActive(id);
            } else if (delBtn) {
                const id = parseInt(delBtn.getAttribute('data-offer-delete'), 10);
                deleteOffer(id);
            }
        });
    }

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
            closeOfferModal();
        }
    });
}

// 在 DOMContentLoaded 之后绑定（admin.js 主流程已在 tryEnterApp 中通过 loadOffers 触发首次加载，
// 但事件绑定要在 DOM 存在后立即完成，这里独立监听 DOMContentLoaded 以避免依赖 initEventListeners）
document.addEventListener('DOMContentLoaded', () => {
    initOfferEvents();
    initEnvironmentAdmin();
    initDoctorAdmin();
});


// ============================================================
// 环境展示管理（图片 + 顶部文案 同步管理）
// ============================================================
let ENV_LIST = [];
let envEditingId = null;

function escEnv(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function envSizeLabel(size) {
    return ({
        small: '小图', medium: '中图', large: '大图', tall: '高图', wide: '宽图',
    })[size] || '中图';
}

async function loadEnvironments() {
    try {
        const resp = await apiFetch('/api/admin/environments');
        const result = await readApiJson(resp);
        if (!resp.ok || result.code !== 0) {
            throw new Error(result.detail || `HTTP ${resp.status}`);
        }
        const data = result.data || {};
        ENV_LIST = Array.isArray(data.items) ? data.items : [];
        renderEnvCards();
        const meta = data.meta || {};
        const setVal = (id, v) => {
            const el = document.getElementById(id);
            if (el && (el.value === '' || el.value == null)) el.value = v || '';
            else if (el) el.value = v || '';
        };
        setVal('envMetaEyebrow', meta.env_eyebrow);
        setVal('envMetaTitle', meta.env_title);
        setVal('envMetaSubtitle', meta.env_subtitle);
        setVal('envAutoplayMs', meta.env_autoplay_ms);
    } catch (e) {
        console.error('加载环境列表失败:', e);
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('加载环境列表失败：' + (e.message || '未知错误'), 'error');
        }
    }
}

function renderEnvCards() {
    const grid = document.getElementById('envCards');
    const empty = document.getElementById('envEmpty');
    if (!grid || !empty) return;

    if (!ENV_LIST.length) {
        grid.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    grid.innerHTML = ENV_LIST.map(it => `
        <div class="env-admin-card relative bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-shadow"
             data-id="${it.id}">
            <div class="aspect-[16/10] bg-gray-100 overflow-hidden relative">
                <img src="${escEnv(it.image)}" alt="${escEnv(it.alt || it.title || '')}"
                     class="w-full h-full object-cover" loading="lazy" decoding="async"
                     onerror="this.parentElement.innerHTML='<div class=\\'w-full h-full flex items-center justify-center text-amber-400\\'><i class=\\'fas fa-triangle-exclamation text-3xl\\'></i></div>'" />
                <span class="absolute top-2 left-2 px-2 py-0.5 rounded text-xs ${it.is_active ? 'bg-emerald-600/90 text-white' : 'bg-gray-700/80 text-white'}">
                    ${it.is_active ? '<i class="fas fa-check mr-1"></i>已上架' : '<i class="fas fa-eye-slash mr-1"></i>已下架'}
                </span>
                <span class="absolute top-2 right-2 px-2 py-0.5 rounded text-xs bg-black/55 text-white">
                    ${escEnv(envSizeLabel(it.size))}
                </span>
            </div>
            <div class="p-4">
                <h4 class="font-semibold text-gray-800 truncate">${escEnv(it.title) || '<span class="text-gray-400">(未命名)</span>'}</h4>
                <p class="text-sm text-gray-500 mt-1 line-clamp-2 min-h-[2.5em]">${escEnv(it.description) || '<span class="text-gray-300">暂无描述</span>'}</p>
                <div class="text-xs text-gray-400 mt-2 flex flex-wrap gap-x-2 gap-y-0.5">
                    <span>排序：${it.sort_order}</span>
                    <span>ID：${it.id}</span>
                    <span class="${(it.duration_ms || 0) > 0 ? 'text-amber-600' : ''}">
                        <i class="far fa-clock mr-0.5"></i>${(it.duration_ms || 0) > 0 ? `${it.duration_ms}ms` : '全局'}
                    </span>
                </div>
                <div class="mt-3 flex flex-wrap gap-2">
                    <button class="env-edit-btn px-3 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700">
                        <i class="fas fa-pen mr-1"></i>编辑
                    </button>
                    <button class="env-toggle-btn px-3 py-1.5 ${it.is_active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white rounded text-xs">
                        <i class="fas ${it.is_active ? 'fa-eye-slash' : 'fa-eye'} mr-1"></i>${it.is_active ? '下架' : '上架'}
                    </button>
                    <button class="env-del-btn px-3 py-1.5 bg-rose-600 text-white rounded text-xs hover:bg-rose-700">
                        <i class="fas fa-trash mr-1"></i>删除
                    </button>
                </div>
            </div>
        </div>
    `).join('');

    // 绑定按钮事件
    grid.querySelectorAll('.env-admin-card').forEach(card => {
        const id = parseInt(card.dataset.id, 10);
        const item = ENV_LIST.find(x => x.id === id);
        if (!item) return;
        card.querySelector('.env-edit-btn').addEventListener('click', () => openEnvModal(item));
        card.querySelector('.env-toggle-btn').addEventListener('click', () => toggleEnvActive(item));
        card.querySelector('.env-del-btn').addEventListener('click', () => deleteEnvironment(item));
    });
}

function openEnvModal(item) {
    envEditingId = item ? item.id : null;
    document.getElementById('envModalTitle').textContent = item ? '编辑环境图片' : '新增环境图片';
    document.getElementById('envEditingId').value = item ? item.id : '';
    document.getElementById('envImage').value = item ? (item.image || '') : '';
    document.getElementById('envTitle').value = item ? (item.title || '') : '';
    document.getElementById('envAlt').value = item ? (item.alt || '') : '';
    document.getElementById('envDescription').value = item ? (item.description || '') : '';
    document.getElementById('envSize').value = (item && item.size) || 'medium';
    document.getElementById('envSortOrder').value = item ? (item.sort_order ?? 100) : 100;
    document.getElementById('envIsActive').checked = item ? !!item.is_active : true;
    document.getElementById('envDurationMs').value = item ? (item.duration_ms ?? 0) : 0;
    document.getElementById('envImageFile').value = '';
    updateEnvImagePreview(item ? item.image : '');

    const m = document.getElementById('envModal');
    m.classList.remove('hidden'); m.classList.add('flex');
}

function closeEnvModal() {
    const m = document.getElementById('envModal');
    m.classList.add('hidden'); m.classList.remove('flex');
    envEditingId = null;
}

function updateEnvImagePreview(url) {
    const wrap = document.getElementById('envImagePreview');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!url) {
        wrap.innerHTML = '<i class="fas fa-image text-3xl text-gray-300"></i>';
        return;
    }
    const img = document.createElement('img');
    img.src = url;
    img.className = 'w-full h-full object-cover';
    img.onerror = () => {
        wrap.innerHTML = '<i class="fas fa-triangle-exclamation text-3xl text-amber-400"></i>';
    };
    wrap.appendChild(img);
}

async function onUploadEnvImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        showNotification('图片大小不能超过 5MB', 'error');
        e.target.value = '';
        return;
    }
    if (!/^image\/(jpe?g|png|webp|gif)$/i.test(file.type)) {
        showNotification('仅支持 jpg / png / webp / gif 格式', 'error');
        e.target.value = '';
        return;
    }
    const btn = document.getElementById('envImageUploadBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>上传中...';
    try {
        const formData = new FormData();
        formData.append('file', file);
        const token = getToken();
        const resp = await fetch('/api/admin/upload/image', {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: formData,
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            const url = result.data.url;
            document.getElementById('envImage').value = url;
            updateEnvImagePreview(url);
            showNotification('上传成功', 'success');
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (err) {
        console.error('上传失败:', err);
        showNotification('上传失败，请稍后重试', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
        e.target.value = '';
    }
}

async function confirmEnvSave() {
    const isEdit = !!envEditingId;
    const image = document.getElementById('envImage').value.trim();
    const title = document.getElementById('envTitle').value.trim();
    const alt = document.getElementById('envAlt').value.trim();
    const description = document.getElementById('envDescription').value.trim();
    const size = document.getElementById('envSize').value || 'medium';
    const sortOrder = parseInt(document.getElementById('envSortOrder').value, 10);
    const isActive = document.getElementById('envIsActive').checked;
    const durationMs = parseInt(document.getElementById('envDurationMs').value, 10);

    if (!image) { showNotification('请上传或填写图片地址', 'error'); return; }
    if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
        showNotification('排序值必须在 0-9999 之间', 'error'); return;
    }
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 60000) {
        showNotification('停留时间必须在 0 ~ 60000 毫秒之间', 'error'); return;
    }
    if (durationMs > 0 && durationMs < 500) {
        showNotification('独立停留时间必须 ≥ 500ms（或填 0 用全局默认）', 'error'); return;
    }

    const payload = {
        image, title, alt, description, size,
        sort_order: sortOrder, is_active: isActive,
        duration_ms: durationMs,
    };
    const url = isEdit ? `/api/admin/environments/${envEditingId}` : '/api/admin/environments';
    const method = isEdit ? 'PUT' : 'POST';
    const btn = document.getElementById('confirmEnvBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
    try {
        const resp = await apiFetch(url, {
            method,
            body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification(isEdit ? '更新成功' : '新增成功', 'success');
            closeEnvModal();
            await loadEnvironments();
            try { localStorage.setItem('yx_environment_updated', String(Date.now())); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('保存失败：' + (e.message || ''), 'error');
        }
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
    }
}

async function toggleEnvActive(item) {
    try {
        const resp = await apiFetch(`/api/admin/environments/${item.id}`, {
            method: 'PUT',
            body: JSON.stringify({ is_active: !item.is_active }),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification(!item.is_active ? '已上架' : '已下架', 'success');
            await loadEnvironments();
            try { localStorage.setItem('yx_environment_updated', String(Date.now())); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('操作失败', 'error');
        }
    }
}

async function deleteEnvironment(item) {
    if (!confirm(`确定要删除该环境图片吗？\n\n${item.title || '(未命名)'}\n删除后客户端将不再展示。`)) return;
    try {
        const resp = await apiFetch(`/api/admin/environments/${item.id}`, {
            method: 'DELETE',
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification('删除成功', 'success');
            await loadEnvironments();
            try { localStorage.setItem('yx_environment_updated', String(Date.now())); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('删除失败', 'error');
        }
    }
}

async function saveEnvMeta() {
    const eyebrow = document.getElementById('envMetaEyebrow').value.trim();
    const title = document.getElementById('envMetaTitle').value.trim();
    const subtitle = document.getElementById('envMetaSubtitle').value.trim();
    const btn = document.getElementById('envMetaSaveBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...';
    try {
        const resp = await apiFetch('/api/admin/environments/meta/text', {
            method: 'PUT',
            body: JSON.stringify({ eyebrow, title, subtitle }),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification('文案已更新', 'success');
            try { localStorage.setItem('yx_environment_updated', String(Date.now())); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('保存失败：' + (e.message || ''), 'error');
        }
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
    }
}

async function saveEnvAutoplay() {
    const ms = parseInt(document.getElementById('envAutoplayMs').value, 10);
    if (!Number.isFinite(ms) || ms < 500 || ms > 60000) {
        showNotification('全局停留时间必须在 500 ~ 60000 毫秒之间', 'error');
        return;
    }
    const btn = document.getElementById('envAutoplaySaveBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...';
    try {
        const resp = await apiFetch('/api/admin/environments/meta/autoplay', {
            method: 'PUT',
            body: JSON.stringify({ autoplay_ms: ms }),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification(`全局停留时间已设为 ${ms}ms`, 'success');
            try { localStorage.setItem('yx_environment_updated', String(Date.now())); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('保存失败：' + (e.message || ''), 'error');
        }
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
    }
}

async function batchApplyEnvDuration() {
    const ms = parseInt(document.getElementById('envBatchDuration').value, 10);
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) {
        showNotification('停留时间必须在 0 ~ 60000 之间（0 = 用全局）', 'error');
        return;
    }
    if (ms > 0 && ms < 500) {
        showNotification('独立停留时间必须 ≥ 500ms（或填 0 用全局）', 'error');
        return;
    }
    const tip = ms === 0
        ? '确定要把所有图片的"独立停留时间"都清零（恢复使用全局默认）吗？'
        : `确定要把所有图片的停留时间都设为 ${ms}ms 吗？`;
    if (!confirm(tip)) return;

    const btn = document.getElementById('envBatchApplyBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>应用中...';
    try {
        const resp = await apiFetch('/api/admin/environments/batch/duration', {
            method: 'PUT',
            body: JSON.stringify({ duration_ms: ms }), // ids 不传 = 应用到所有
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            const aff = (result.data && result.data.affected) || 0;
            showNotification(`已批量更新 ${aff} 张图片`, 'success');
            await loadEnvironments();
            try { localStorage.setItem('yx_environment_updated', String(Date.now())); } catch {}
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('批量更新失败：' + (e.message || ''), 'error');
        }
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
    }
}

function initEnvironmentAdmin() {
    const addBtn = document.getElementById('envAddBtn');
    if (!addBtn) return; // 页面未渲染该模块时跳过

    addBtn.addEventListener('click', () => openEnvModal(null));
    document.getElementById('envRefreshBtn').addEventListener('click', loadEnvironments);
    document.getElementById('closeEnvBtn').addEventListener('click', closeEnvModal);
    document.getElementById('cancelEnvBtn').addEventListener('click', closeEnvModal);
    document.getElementById('confirmEnvBtn').addEventListener('click', confirmEnvSave);
    document.getElementById('envMetaSaveBtn').addEventListener('click', saveEnvMeta);
    // 全局停留时间 + 批量应用
    const autoplayBtn = document.getElementById('envAutoplaySaveBtn');
    if (autoplayBtn) autoplayBtn.addEventListener('click', saveEnvAutoplay);
    const batchBtn = document.getElementById('envBatchApplyBtn');
    if (batchBtn) batchBtn.addEventListener('click', batchApplyEnvDuration);

    // 图片 URL 输入实时预览
    document.getElementById('envImage').addEventListener('input', (e) => {
        updateEnvImagePreview(e.target.value.trim());
    });

    // 上传图片
    const fileInput = document.getElementById('envImageFile');
    document.getElementById('envImageUploadBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', onUploadEnvImage);

    // 点击遮罩关闭
    document.getElementById('envModal').addEventListener('click', (e) => {
        if (e.target.id === 'envModal') closeEnvModal();
    });

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const m = document.getElementById('envModal');
            if (m && !m.classList.contains('hidden')) closeEnvModal();
        }
    });
}


// ============================================================
// 医生管理（CRUD）
// ============================================================
let DOCTORS_LIST = [];
let doctorEditingId = null;

function escDoc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function loadDoctors() {
    try {
        const resp = await apiFetch('/api/admin/doctors');
        const result = await readApiJson(resp);
        if (!resp.ok || result.code !== 0) {
            throw new Error(result.detail || `HTTP ${resp.status}`);
        }
        DOCTORS_LIST = Array.isArray(result.data) ? result.data : [];
        renderDoctorCards();
        // 同步刷新 META.doctors，保证预约编辑弹窗的医生下拉是最新的
        if (META && Array.isArray(META.doctors)) {
            META.doctors = DOCTORS_LIST.filter(d => d.is_active).map(d => d.name);
        }
    } catch (e) {
        console.error('加载医生列表失败:', e);
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('加载医生列表失败：' + (e.message || '未知错误'), 'error');
        }
    }
}

function renderDoctorCards() {
    const grid = document.getElementById('doctorCards');
    const empty = document.getElementById('doctorEmpty');
    if (!grid || !empty) return;

    if (!DOCTORS_LIST.length) {
        grid.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    grid.innerHTML = DOCTORS_LIST.map(d => {
        const avatarHtml = d.avatar
            ? `<img src="${escDoc(d.avatar)}" alt="${escDoc(d.name)}" class="w-full h-full object-cover" loading="lazy"
                    onerror="this.parentElement.innerHTML='<i class=\\'fas fa-user-md text-3xl text-gray-300\\'></i>'" />`
            : '<i class="fas fa-user-md text-3xl text-gray-300"></i>';
        return `
        <div class="doctor-card relative bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-shadow"
             data-id="${d.id}">
            <div class="p-5 text-center">
                <div class="w-20 h-20 mx-auto rounded-full bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center">
                    ${avatarHtml}
                </div>
                <h4 class="mt-3 font-semibold text-gray-800">${escDoc(d.name)}</h4>
                <p class="text-xs text-gray-500 mt-0.5 truncate">${escDoc(d.title) || '<span class="text-gray-300">未填写职称</span>'}</p>
                <p class="text-xs text-gray-400 mt-2 line-clamp-2 min-h-[2.5em]">${escDoc(d.bio) || '<span class="text-gray-300">暂无简介</span>'}</p>
                <div class="mt-3 flex items-center justify-center gap-2 text-xs text-gray-500">
                    <span class="px-2 py-0.5 rounded ${d.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}">
                        ${d.is_active ? '已启用' : '已停用'}
                    </span>
                    <span>排序：${d.sort_order}</span>
                </div>
                <div class="mt-3 flex flex-wrap justify-center gap-2">
                    <button class="doctor-edit-btn px-3 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700">
                        <i class="fas fa-pen mr-1"></i>编辑
                    </button>
                    <button class="doctor-toggle-btn px-3 py-1.5 ${d.is_active ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'} text-white rounded text-xs">
                        <i class="fas ${d.is_active ? 'fa-eye-slash' : 'fa-eye'} mr-1"></i>${d.is_active ? '停用' : '启用'}
                    </button>
                    <button class="doctor-del-btn px-3 py-1.5 bg-rose-600 text-white rounded text-xs hover:bg-rose-700">
                        <i class="fas fa-trash mr-1"></i>删除
                    </button>
                </div>
            </div>
        </div>
        `;
    }).join('');

    grid.querySelectorAll('.doctor-card').forEach(card => {
        const id = parseInt(card.dataset.id, 10);
        const d = DOCTORS_LIST.find(x => x.id === id);
        if (!d) return;
        card.querySelector('.doctor-edit-btn').addEventListener('click', () => openDoctorModal(d));
        card.querySelector('.doctor-toggle-btn').addEventListener('click', () => toggleDoctorActive(d));
        card.querySelector('.doctor-del-btn').addEventListener('click', () => deleteDoctor(d));
    });
}

function openDoctorModal(d) {
    doctorEditingId = d ? d.id : null;
    document.getElementById('doctorModalTitle').textContent = d ? '编辑医生' : '新增医生';
    document.getElementById('doctorEditingId').value = d ? d.id : '';
    document.getElementById('doctorName').value = d ? (d.name || '') : '';
    document.getElementById('doctorTitle').value = d ? (d.title || '') : '';
    document.getElementById('doctorAvatar').value = d ? (d.avatar || '') : '';
    document.getElementById('doctorBio').value = d ? (d.bio || '') : '';
    document.getElementById('doctorSortOrder').value = d ? (d.sort_order ?? 100) : 100;
    document.getElementById('doctorIsActive').checked = d ? !!d.is_active : true;
    document.getElementById('doctorAvatarFile').value = '';
    updateDoctorAvatarPreview(d ? d.avatar : '');

    const m = document.getElementById('doctorModal');
    m.classList.remove('hidden'); m.classList.add('flex');
}

function closeDoctorModal() {
    const m = document.getElementById('doctorModal');
    m.classList.add('hidden'); m.classList.remove('flex');
    doctorEditingId = null;
}

function updateDoctorAvatarPreview(url) {
    const wrap = document.getElementById('doctorAvatarPreview');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!url) {
        wrap.innerHTML = '<i class="fas fa-user-md text-3xl text-gray-300"></i>';
        return;
    }
    const img = document.createElement('img');
    img.src = url;
    img.className = 'w-full h-full object-cover';
    img.onerror = () => {
        wrap.innerHTML = '<i class="fas fa-triangle-exclamation text-3xl text-amber-400"></i>';
    };
    wrap.appendChild(img);
}

async function onUploadDoctorAvatar(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        showNotification('图片大小不能超过 5MB', 'error');
        e.target.value = '';
        return;
    }
    if (!/^image\/(jpe?g|png|webp|gif)$/i.test(file.type)) {
        showNotification('仅支持 jpg / png / webp / gif 格式', 'error');
        e.target.value = '';
        return;
    }
    const btn = document.getElementById('doctorAvatarUploadBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>上传中...';
    try {
        const formData = new FormData();
        formData.append('file', file);
        const token = getToken();
        const resp = await fetch('/api/admin/upload/image', {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: formData,
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            const url = result.data.url;
            document.getElementById('doctorAvatar').value = url;
            updateDoctorAvatarPreview(url);
            showNotification('上传成功', 'success');
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (err) {
        console.error('上传失败:', err);
        showNotification('上传失败，请稍后重试', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
        e.target.value = '';
    }
}

async function confirmDoctorSave() {
    const isEdit = !!doctorEditingId;
    const name = document.getElementById('doctorName').value.trim();
    const title = document.getElementById('doctorTitle').value.trim();
    const avatar = document.getElementById('doctorAvatar').value.trim();
    const bio = document.getElementById('doctorBio').value.trim();
    const sortOrder = parseInt(document.getElementById('doctorSortOrder').value, 10);
    const isActive = document.getElementById('doctorIsActive').checked;

    if (!name) { showNotification('姓名不能为空', 'error'); return; }
    if (!/^[\u4e00-\u9fa5A-Za-z0-9·\-_\s]{1,30}$/.test(name)) {
        showNotification('姓名只能包含中英文/数字/·-_/空格，1-30 位', 'error');
        return;
    }
    if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
        showNotification('排序值必须在 0-9999 之间', 'error'); return;
    }

    const payload = { name, title, avatar, bio, sort_order: sortOrder, is_active: isActive };
    const url = isEdit ? `/api/admin/doctors/${doctorEditingId}` : '/api/admin/doctors';
    const method = isEdit ? 'PUT' : 'POST';
    const btn = document.getElementById('confirmDoctorBtn');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
    try {
        const resp = await apiFetch(url, { method, body: JSON.stringify(payload) });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification(isEdit ? '更新成功' : '新增成功', 'success');
            closeDoctorModal();
            await loadDoctors();
            // 重新刷新 meta，让预约编辑弹窗也即时更新
            await refreshMetaDoctors();
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('保存失败：' + (e.message || ''), 'error');
        }
    } finally {
        btn.disabled = false; btn.innerHTML = orig;
    }
}

async function refreshMetaDoctors() {
    try {
        const r = await apiFetch('/api/admin/meta');
        const j = await r.json();
        if (j.code === 0 && j.data) {
            META.doctors = Array.isArray(j.data.doctors) ? j.data.doctors : META.doctors;
            // 顺手刷新 sources（共用同一个接口，节省一次请求）
            if (Array.isArray(j.data.sources)) {
                META.sources = j.data.sources;
                refreshSourceFilter();
            }
        }
    } catch { /* ignore */ }
}

/**
 * 重新拉取 META.sources（基础来源 + 后台动态优惠 offer_key）并刷新顶部"来源/套餐"下拉。
 * - 在优惠活动新增 / 修改 / 删除 / 上下架成功后调用
 * - 保持当前已选值（如该值仍存在则不变；不存在则回到"全部来源"）
 */
async function refreshMetaSources() {
    try {
        const r = await apiFetch('/api/admin/meta');
        const j = await r.json();
        if (j.code !== 0 || !j.data || !Array.isArray(j.data.sources)) return;
        META.sources = j.data.sources;
        refreshSourceFilter();
    } catch { /* ignore */ }
}

/**
 * 用最新的 META.sources 刷新 #sourceFilter 下拉项（保留"全部来源"占位）。
 * 单独抽出来，避免重新跑整个 fillFilterOptions（其他下拉无需重置）。
 */
function refreshSourceFilter() {
    const sel = document.getElementById('sourceFilter');
    if (!sel) return;
    const prev = sel.value;
    // 保留占位首项"全部来源"
    const placeholder = sel.querySelector('option[value=""]');
    sel.innerHTML = '';
    if (placeholder) sel.appendChild(placeholder);
    else {
        const ph = document.createElement('option');
        ph.value = ''; ph.textContent = '全部来源';
        sel.appendChild(ph);
    }
    (META.sources || []).forEach(item => {
        const o = document.createElement('option');
        o.value = item.id;
        o.textContent = item.name;
        sel.appendChild(o);
    });
    // 尽量保留之前选中的值；若该值已不存在（优惠被删了）→ 回到"全部"
    const stillExists = !!Array.from(sel.options).find(o => o.value === prev);
    sel.value = stillExists ? prev : '';
}

async function toggleDoctorActive(d) {
    try {
        const resp = await apiFetch(`/api/admin/doctors/${d.id}`, {
            method: 'PUT',
            body: JSON.stringify({ is_active: !d.is_active }),
        });
        const result = await resp.json();
        if (resp.ok && result.code === 0) {
            showNotification(!d.is_active ? '已启用' : '已停用', 'success');
            await loadDoctors();
            await refreshMetaDoctors();
        } else {
            showNotification(formatBackendError(result), 'error');
        }
    } catch (e) {
        if (e.message !== '未登录或会话已过期，请重新登录') {
            showNotification('操作失败', 'error');
        }
    }
}

async function deleteDoctor(d) {
    if (!confirm(`确定要删除医生"${d.name}"吗？\n\n如果该医生仍被预约绑定，会提示需 force 强制删除（删除时会清空预约的医生字段）。`)) return;
    let force = 0;
    while (true) {
        try {
            const resp = await apiFetch(`/api/admin/doctors/${d.id}${force ? '?force=1' : ''}`, {
                method: 'DELETE',
            });
            const result = await resp.json();
            if (resp.ok && result.code === 0) {
                showNotification('删除成功', 'success');
                await loadDoctors();
                await refreshMetaDoctors();
                return;
            }
            // 引用拦截 → 提示是否强删
            if (resp.status === 400 && /force=1/.test(result.detail || '')) {
                if (confirm(`${result.detail}\n\n是否强制删除？`)) {
                    force = 1;
                    continue;
                }
                return;
            }
            showNotification(formatBackendError(result), 'error');
            return;
        } catch (e) {
            if (e.message !== '未登录或会话已过期，请重新登录') {
                showNotification('删除失败', 'error');
            }
            return;
        }
    }
}

function initDoctorAdmin() {
    const addBtn = document.getElementById('doctorAddBtn');
    if (!addBtn) return;
    addBtn.addEventListener('click', () => openDoctorModal(null));
    document.getElementById('doctorRefreshBtn').addEventListener('click', loadDoctors);
    document.getElementById('closeDoctorBtn').addEventListener('click', closeDoctorModal);
    document.getElementById('cancelDoctorBtn').addEventListener('click', closeDoctorModal);
    document.getElementById('confirmDoctorBtn').addEventListener('click', confirmDoctorSave);

    document.getElementById('doctorAvatar').addEventListener('input', (e) => {
        updateDoctorAvatarPreview(e.target.value.trim());
    });

    const fileInput = document.getElementById('doctorAvatarFile');
    document.getElementById('doctorAvatarUploadBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', onUploadDoctorAvatar);

    document.getElementById('doctorModal').addEventListener('click', (e) => {
        if (e.target.id === 'doctorModal') closeDoctorModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const m = document.getElementById('doctorModal');
            if (m && !m.classList.contains('hidden')) closeDoctorModal();
        }
    });
}
