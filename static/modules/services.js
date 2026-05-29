// 服务列表渲染与多维度筛选（数据来自后端 /api/services，本地 SERVICES 作降级 fallback）
import {
    CATEGORIES as FALLBACK_CATEGORIES,
    TAGS as FALLBACK_TAGS,
    DURATIONS, PRICE_RANGES, SORT_OPTIONS,
    SERVICES as FALLBACK_SERVICES,
} from '../data/services.js';
import {
    escapeHtml,
    normalizeMetaCategory,
    normalizeMetaTag,
    normalizeService,
    safeClassTokens,
    sanitizeFaIcon,
} from './schema.js';

// 实际使用的服务列表（启动时从后端拉取覆盖）
let SERVICES = FALLBACK_SERVICES.map(normalizeService);
// 实际使用的分类与标签（启动时从 /api/meta 拉取，与管理端实时一致）
// 客户端渲染规则：分类列表前永远保留 "全部项目" 一项
let CATEGORIES = FALLBACK_CATEGORIES.slice();
let TAGS = FALLBACK_TAGS.slice();

async function fetchServices() {
    try {
        const resp = await fetch('/api/services', { cache: 'no-store' });
        const result = await resp.json();
        if (result.code === 0 && Array.isArray(result.data) && result.data.length) {
            SERVICES = result.data.map(normalizeService);
            return true;
        }
    } catch (e) {
        console.warn('加载服务列表失败，使用本地降级数据', e);
    }
    return false;
}

/**
 * 拉取分类与标签元数据（公开接口，无需鉴权）。
 * - 返回的分类列表会自动在最前面拼上 “全部项目” 哨兵项；
 * - 标签列表用于 tagMeta 反查，未知标签走自定义芯片样式。
 * 该接口由管理后台保存项目时自动 upsert 维护，确保管理端与客户端实时一致。
 */
async function fetchMeta() {
    try {
        const resp = await fetch('/api/meta', { cache: 'no-store' });
        const result = await resp.json();
        if (result.code === 0 && result.data) {
            const cats = Array.isArray(result.data.categories) ? result.data.categories : [];
            if (cats.length) {
                // 服务端字段：{id, name, icon, builtin, sort_order}
                CATEGORIES = [
                    { id: 'all', name: '全部项目', icon: 'fa-spa' },
                    ...cats.map(normalizeMetaCategory).filter(c => c.id),
                ];
            }
            const tags = Array.isArray(result.data.tags) ? result.data.tags : [];
            if (tags.length) {
                // 服务端字段：{id, label, color, builtin, sort_order}
                TAGS = tags.map(normalizeMetaTag).filter(t => t.id);
            }
            return true;
        }
    } catch (e) {
        console.warn('加载分类/标签元数据失败，使用本地降级数据', e);
    }
    return false;
}

// 当前筛选状态
const state = {
    category: 'all',
    duration: 'all',
    price: 'all',
    sort: 'default',
    keyword: '',
    favorites: new Set(loadFavorites()),
};

const FAV_KEY = 'spa_favorites_v1';
function loadFavorites() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch { return []; }
}
function saveFavorites() {
    localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
}

// 上报收藏事件（add / remove），失败静默
function reportFavorite(eventType, s) {
    try {
        const sessionId = sessionStorage.getItem('spa_session_id') || '';
        const body = JSON.stringify({
            event_type: eventType,
            event_data: {
                service_id: s.id,
                service: s.name,
                category: s.category,
            },
            page_url: window.location.href,
            referrer: document.referrer || '',
            session_id: sessionId,
        });
        // 优先使用 sendBeacon，避免页面跳转丢失
        if (navigator.sendBeacon) {
            const blob = new Blob([body], { type: 'application/json' });
            navigator.sendBeacon('/api/analytics', blob);
        } else {
            fetch('/api/analytics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            }).catch(() => {});
        }
    } catch { /* 静默失败 */ }
}

// 工具：根据 tag id 找 meta（实时使用 TAGS，TAGS 在 fetchMeta 后被替换）
function tagMeta(id) {
    return TAGS.find(t => t.id === id);
}

// 工具：根据筛选返回项目
function filterServices() {
    const dur = DURATIONS.find(d => d.id === state.duration);
    const pr = PRICE_RANGES.find(p => p.id === state.price);
    const kw = state.keyword.trim().toLowerCase();

    let list = SERVICES.filter(s => {
        if (state.category !== 'all' && s.category !== state.category) return false;
        if (s.duration < dur.min || s.duration > dur.max) return false;
        if (s.price < pr.min || s.price > pr.max) return false;
        if (kw) {
            const text = [
                s.name, s.subtitle, s.suitableFor, s.description,
                ...(s.effects || []),
                ...(s.tags || []).map(t => tagMeta(t)?.label || ''),
            ].join(' ').toLowerCase();
            if (!text.includes(kw)) return false;
        }
        return true;
    });

    switch (state.sort) {
        case 'hot':         list.sort((a, b) => b.popularity - a.popularity); break;
        case 'price_asc':   list.sort((a, b) => a.price - b.price);            break;
        case 'price_desc':  list.sort((a, b) => b.price - a.price);            break;
        case 'duration':    list.sort((a, b) => a.duration - b.duration);      break;
        default:
            // 综合推荐：tag 含 recommend 优先，再按 popularity
            list.sort((a, b) => {
                const ra = (a.tags || []).includes('recommend') ? 1 : 0;
                const rb = (b.tags || []).includes('recommend') ? 1 : 0;
                return (rb - ra) || (b.popularity - a.popularity);
            });
    }
    return list;
}

// ---------- 渲染：分类 Tab ----------
function renderCategoryTabs(host) {
    host.innerHTML = '';
    CATEGORIES.forEach(c => {
        const btn = document.createElement('button');
        btn.className = `category-tab ${state.category === c.id ? 'active' : ''}`;
        const icon = document.createElement('i');
        icon.className = `fas ${sanitizeFaIcon(c.icon, 'fa-tag')}`;
        const label = document.createElement('span');
        label.textContent = c.name;
        btn.appendChild(icon);
        btn.appendChild(label);
        btn.addEventListener('click', () => {
            state.category = c.id;
            renderAll();
        });
        host.appendChild(btn);
    });
}

// ---------- 渲染：筛选条 ----------
function renderFilters(host) {
    host.innerHTML = '';

    host.appendChild(buildSelect('时长', DURATIONS, state.duration, v => {
        state.duration = v; renderAll();
    }));
    host.appendChild(buildSelect('价格', PRICE_RANGES, state.price, v => {
        state.price = v; renderAll();
    }));
    host.appendChild(buildSelect('排序', SORT_OPTIONS, state.sort, v => {
        state.sort = v; renderAll();
    }));

    // 重置
    const reset = document.createElement('button');
    reset.className = 'filter-reset';
    reset.innerHTML = '<i class="fas fa-rotate-left"></i> 重置';
    reset.addEventListener('click', () => {
        state.category = 'all';
        state.duration = 'all';
        state.price = 'all';
        state.sort = 'default';
        state.keyword = '';
        document.getElementById('serviceSearchInput').value = '';
        renderAll();
    });
    host.appendChild(reset);
}

function buildSelect(label, options, current, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'filter-group';
    const lbl = document.createElement('label');
    lbl.className = 'filter-label';
    lbl.textContent = label;
    const sel = document.createElement('select');
    sel.className = 'filter-select';
    options.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = o.label || o.name;
        if (o.id === current) opt.selected = true;
        sel.appendChild(opt);
    });
    sel.addEventListener('change', e => onChange(e.target.value));
    wrap.appendChild(lbl);
    wrap.appendChild(sel);
    return wrap;
}

// ---------- 渲染：服务卡片网格 ----------
function renderGrid(host, list) {
    host.innerHTML = '';
    if (!list.length) {
        host.appendChild(buildEmptyState());
        return;
    }
    list.forEach((s, idx) => host.appendChild(buildServiceCard(s, idx)));
    // 触发可见动画
    requestAnimationFrame(() => {
        host.querySelectorAll('.service-card').forEach(el => el.classList.add('in'));
    });
}

function buildServiceCard(s, index) {
    const card = document.createElement('article');
    card.className = 'service-card';
    card.style.transitionDelay = `${Math.min(index * 40, 320)}ms`;
    card.dataset.service = s.name;
    card.dataset.serviceId = s.id;
    card.dataset.category = s.category;

    // 顶部图
    const media = document.createElement('div');
    media.className = 'service-media';
    const img = document.createElement('img');
    img.src = s.image;
    img.alt = s.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    media.appendChild(img);

    // 收藏
    const fav = document.createElement('button');
    fav.className = `fav-btn ${state.favorites.has(s.id) ? 'on' : ''}`;
    fav.setAttribute('aria-label', '收藏');
    fav.innerHTML = '<i class="fas fa-heart"></i>';
    fav.addEventListener('click', e => {
        e.stopPropagation();
        const willFavorite = !state.favorites.has(s.id);
        if (willFavorite) {
            state.favorites.add(s.id);
        } else {
            state.favorites.delete(s.id);
        }
        saveFavorites();
        fav.classList.toggle('on');
        // 上报埋点：用于后台收藏统计
        reportFavorite(willFavorite ? 'favorite_add' : 'favorite_remove', s);
    });
    media.appendChild(fav);

    // 标签
    if (s.tags && s.tags.length) {
        const tagWrap = document.createElement('div');
        tagWrap.className = 'tag-wrap';
        s.tags.slice(0, 3).forEach(t => {
            const meta = tagMeta(t);
            const span = document.createElement('span');
            if (meta) {
                span.className = `tag ${safeClassTokens(meta.color, 'bg-slate-500')}`;
                span.textContent = meta.label;
            } else {
                // 自定义标签：用默认色，文本即标签 id
                span.className = 'tag tag-custom';
                span.textContent = t;
            }
            tagWrap.appendChild(span);
        });
        media.appendChild(tagWrap);
    }

    // 标题区
    const titleBlock = document.createElement('div');
    titleBlock.className = 'service-title-block';
    const h3 = document.createElement('h3');
    h3.className = 'service-title';
    h3.textContent = s.name;
    const sub = document.createElement('p');
    sub.className = 'service-subtitle';
    sub.textContent = s.subtitle;
    titleBlock.appendChild(h3);
    titleBlock.appendChild(sub);
    media.appendChild(titleBlock);

    card.appendChild(media);

    // 主体
    const body = document.createElement('div');
    body.className = 'service-body';

    // 功效芯片
    if (s.effects && s.effects.length) {
        const effects = document.createElement('div');
        effects.className = 'effect-chips';
        s.effects.slice(0, 3).forEach(e => {
            const chip = document.createElement('span');
            chip.className = 'effect-chip';
            chip.textContent = e;
            effects.appendChild(chip);
        });
        body.appendChild(effects);
    }

    // 时长
    const meta = document.createElement('div');
    meta.className = 'service-meta';
    meta.innerHTML = `
        <span><i class="far fa-clock"></i> ${s.duration} 分钟</span>
        <span><i class="far fa-user"></i> ${escapeHtml(s.suitableFor)}</span>
    `;
    body.appendChild(meta);

    // 价格 + 按钮
    const footer = document.createElement('div');
    footer.className = 'service-footer';
    const priceWrap = document.createElement('div');
    priceWrap.className = 'price-wrap';
    priceWrap.innerHTML = `
        <span class="price-now">¥${s.price}</span>
        ${s.originalPrice ? `<span class="price-origin">¥${s.originalPrice}</span>` : ''}
    `;
    const btnWrap = document.createElement('div');
    btnWrap.className = 'btn-wrap';
    // 咨询电话按钮（仅当配置了项目电话时显示）
    if (s.contactPhone) {
        const callBtn = document.createElement('button');
        callBtn.className = 'btn-call';
        callBtn.title = '电话咨询';
        callBtn.innerHTML = '<i class="fas fa-phone-alt"></i>';
        callBtn.addEventListener('click', e => {
            e.stopPropagation();
            openContactPopup(s);
        });
        btnWrap.appendChild(callBtn);
    }
    const detailBtn = document.createElement('button');
    detailBtn.className = 'btn-detail';
    detailBtn.textContent = '详情';
    detailBtn.addEventListener('click', e => { e.stopPropagation(); openDetail(s); });
    const bookBtn = document.createElement('button');
    bookBtn.className = 'book-btn btn-book';
    bookBtn.textContent = '立即预约';
    btnWrap.appendChild(detailBtn);
    btnWrap.appendChild(bookBtn);
    footer.appendChild(priceWrap);
    footer.appendChild(btnWrap);
    body.appendChild(footer);

    card.appendChild(body);

    // 整卡点击进详情
    card.addEventListener('click', () => openDetail(s));

    return card;
}

function buildEmptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
        <i class="fas fa-magnifying-glass"></i>
        <p>没有符合条件的项目</p>
        <span>试试调整筛选条件或关键词</span>
    `;
    return div;
}

// ---------- 详情弹窗 ----------
function openDetail(s) {
    const modal = document.getElementById('serviceDetailModal');
    if (!modal) return;
    const c = modal.querySelector('[data-detail-content]');
    c.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'detail-head';
    head.style.backgroundImage = `url(${s.image})`;

    const inner = document.createElement('div');
    inner.className = 'detail-head-inner';
    inner.innerHTML = `
        <div class="detail-tags">
            ${(s.tags || []).map(t => {
                const m = tagMeta(t);
                return m
                    ? `<span class="tag ${safeClassTokens(m.color, 'bg-slate-500')}">${escapeHtml(m.label)}</span>`
                    : `<span class="tag tag-custom">${escapeHtml(t)}</span>`;
            }).join('')}
        </div>
        <h3>${escapeHtml(s.name)}</h3>
        <p>${escapeHtml(s.subtitle || '')}</p>
    `;
    head.appendChild(inner);
    c.appendChild(head);

    const body = document.createElement('div');
    body.className = 'detail-body';
    body.innerHTML = `
        <div class="detail-meta">
            <div><i class="far fa-clock"></i><span>${s.duration} 分钟</span></div>
            <div><i class="fas fa-user-check"></i><span>${escapeHtml(s.suitableFor)}</span></div>
            <div><i class="fas fa-tags"></i><span>限时优惠</span></div>
        </div>
        <div class="detail-price">
            <span class="price-now">¥${s.price}</span>
            ${s.originalPrice ? `<span class="price-origin">¥${s.originalPrice}</span>` : ''}
        </div>
        <h4 class="detail-section-title">疗效特点</h4>
        <ul class="detail-effects">
            ${(s.effects || []).map(e => `<li><i class="fas fa-check-circle"></i>${escapeHtml(e)}</li>`).join('')}
        </ul>
        <h4 class="detail-section-title">项目介绍</h4>
        <p class="detail-desc">${escapeHtml(s.description)}</p>
    `;
    c.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    actions.innerHTML = `
        <button type="button" class="btn-ghost" data-call><i class="fas fa-phone-alt"></i>电话咨询</button>
        <button type="button" class="btn-primary" data-book>立即预约</button>
    `;
    c.appendChild(actions);

    actions.querySelector('[data-call]').addEventListener('click', () => {
        openContactPopup(s);
    });

    actions.querySelector('[data-book]').addEventListener('click', () => {
        closeDetail();
        // 通知预约模块打开弹窗并带入完整上下文（真实服务名 + 分类）
        document.dispatchEvent(new CustomEvent('open-booking', {
            detail: {
                serviceType: s.name,      // 使用真实服务名，后端已支持全部 16 项
                serviceDisplay: s.name,
                category: s.category,
                source: 'normal',
            },
        }));
    });

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}
function closeDetail() {
    const modal = document.getElementById('serviceDetailModal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.style.overflow = '';
}

// ---------- 主入口 ----------
function renderAll() {
    const grid = document.getElementById('serviceGrid');
    const tabs = document.getElementById('categoryTabs');
    const filters = document.getElementById('serviceFilters');
    const count = document.getElementById('serviceCount');
    if (!grid || !tabs || !filters) return;

    const list = filterServices();
    renderCategoryTabs(tabs);
    renderFilters(filters);
    renderGrid(grid, list);
    if (count) count.textContent = `共 ${list.length} 项`;
}

export function initServices() {
    // 关闭详情弹窗事件
    const modal = document.getElementById('serviceDetailModal');
    if (modal) {
        modal.addEventListener('click', e => {
            if (e.target.closest('[data-close]') || e.target === modal) closeDetail();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && modal.classList.contains('active')) closeDetail();
        });
    }

    // 搜索框
    const searchInput = document.getElementById('serviceSearchInput');
    if (searchInput) {
        let timer = null;
        searchInput.addEventListener('input', e => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                state.keyword = e.target.value;
                renderAll();
            }, 200);
        });
    }

    // 先用 fallback 渲染（保证骨架立刻可见），再异步替换
    renderAll();
    // 并行拉取分类/标签元数据 + 服务列表，全部完成后再渲染一次，
    // 保证客户端 Tab、芯片和管理端实时一致（含管理端新增的自定义分类/标签）
    Promise.all([fetchMeta(), fetchServices()]).then(([metaOk, svcOk]) => {
        if (metaOk || svcOk) renderAll();
    });

    // 准实时同步：管理端在同源页面保存项目时通过 BroadcastChannel / storage / postMessage 通知，
    // 这里监听后立即刷新；也支持页面 visibility 变化时被动拉一次
    setupRealtimeSync();
}

/**
 * 准实时同步：
 * - BroadcastChannel('yx-service-sync')：同源页面之间 0 延迟通知
 * - storage 事件：跨标签页广播（管理端 admin.js 在保存时调用 notifyServiceChanged）
 * - visibilitychange：用户切回页面时重新拉一次
 * - 兜底：每 60s 轻量轮询一次（仅在 tab 可见时）
 */
function setupRealtimeSync() {
    const refresh = async () => {
        const [m, s] = await Promise.all([fetchMeta(), fetchServices()]);
        if (m || s) renderAll();
    };

    // 1) BroadcastChannel
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            const bc = new BroadcastChannel('yx-service-sync');
            bc.addEventListener('message', (ev) => {
                if (ev.data && ev.data.type === 'service-changed') refresh();
            });
        } catch { /* 静默 */ }
    }

    // 2) localStorage 跨标签页事件
    window.addEventListener('storage', (e) => {
        if (e.key === 'yx_service_sync_tick') refresh();
    });

    // 3) 切回前台时拉一次
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
    });

    // 4) 兜底：可见状态下每 60s 拉一次
    setInterval(() => {
        if (document.visibilityState === 'visible') refresh();
    }, 60_000);
}

// 暴露给可能内嵌在同页的管理脚本（一般无用，但保留）
if (typeof window !== 'undefined') {
    window.__yxRefreshServices = async () => {
        await Promise.all([fetchMeta(), fetchServices()]);
        renderAll();
    };
}


// ===================== 项目专属电话弹窗 =====================
let GLOBAL_CONTACT_PHONE = '';
async function loadGlobalPhone() {
    if (GLOBAL_CONTACT_PHONE) return GLOBAL_CONTACT_PHONE;
    try {
        const resp = await fetch('/api/contact-info', { cache: 'no-store' });
        const result = await resp.json();
        if (result.code === 0) {
            const phone = (result.data || []).find(i => i.type === 'phone');
            if (phone) GLOBAL_CONTACT_PHONE = phone.value;
        }
    } catch (e) { /* 忽略 */ }
    return GLOBAL_CONTACT_PHONE;
}

async function openContactPopup(service) {
    let phone = service.contactPhone || '';
    let label = '项目专属咨询';
    if (!phone) {
        phone = await loadGlobalPhone();
        label = '门店咨询电话';
    }
    if (!phone) {
        phone = '400-888-8888';
        label = '门店咨询电话';
    }
    showContactDialog(service.name, phone, label);
}

function showContactDialog(serviceName, phone, label) {
    // 移除已存在的（避免重复）
    document.querySelectorAll('.contact-popup').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'contact-popup';
    overlay.innerHTML = `
        <div class="contact-popup-card">
            <button class="contact-popup-close" aria-label="关闭">
                <i class="fas fa-times"></i>
            </button>
            <div class="contact-popup-icon">
                <i class="fas fa-phone-alt"></i>
            </div>
            <h3 class="contact-popup-title"></h3>
            <p class="contact-popup-sub"></p>
            <button type="button" class="contact-link contact-popup-phone" data-copy="">
                <span class="contact-popup-phone-text"></span>
            </button>
            <p class="contact-popup-tip">
                <i class="fas fa-info-circle"></i>
                点击号码即可一键复制 · 营业时间 10:00 - 22:00
            </p>
            <a class="btn-primary contact-popup-call" href="">
                <i class="fas fa-phone-alt"></i> 立即拨打
            </a>
        </div>
    `;
    overlay.querySelector('.contact-popup-title').textContent = label;
    overlay.querySelector('.contact-popup-sub').textContent = serviceName ? `「${serviceName}」` : '';
    overlay.querySelector('.contact-popup-phone-text').textContent = phone;
    overlay.querySelector('.contact-popup-phone').dataset.copy = phone;
    overlay.querySelector('.contact-popup-call').href = `tel:${phone.replace(/\s/g, '')}`;

    overlay.addEventListener('click', e => {
        if (e.target === overlay) closeContactDialog(overlay);
    });
    overlay.querySelector('.contact-popup-close').addEventListener('click', () => closeContactDialog(overlay));
    document.addEventListener('keydown', escClose);
    function escClose(e) {
        if (e.key === 'Escape') {
            closeContactDialog(overlay);
            document.removeEventListener('keydown', escClose);
        }
    }

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    document.body.style.overflow = 'hidden';
}

function closeContactDialog(overlay) {
    overlay.classList.remove('show');
    document.body.style.overflow = '';
    setTimeout(() => overlay.parentNode && overlay.parentNode.removeChild(overlay), 280);
}
