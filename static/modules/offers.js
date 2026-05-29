// 优惠活动模块：从后端拉取数据并动态渲染 #offers .offer-grid
// 与 booking.js 的 .offer-btn / data-offer 事件兼容
// 服务端字段：{ id, offer_key, name, icon, theme, price, original_price,
//             price_suffix, features:[], btn_text, source, sort_order, is_active }
import { escapeHtml as esc, normalizeOffer, sanitizeFaIcon } from './schema.js';

const OFFERS_ENDPOINT = '/api/offers';

// 主题白名单 → 兜底
const ALLOWED_THEMES = new Set([
    'offer-1', 'offer-2', 'offer-3', 'offer-4',
    'offer-5', 'offer-6', 'offer-7', 'offer-8',
    'offer-9', 'offer-10', 'offer-11', 'offer-12',
]);

function buildOfferCard(o, idx) {
    const theme = ALLOWED_THEMES.has(o.theme) ? o.theme
                : `offer-${(idx % 3) + 1}`;
    const icon = sanitizeFaIcon(o.icon, 'fa-gift');
    const name = esc(o.name || '');
    const price = esc(o.price || '');
    const cmp = esc(o.original_price || '');
    const suffix = esc(o.price_suffix || '');
    const features = Array.isArray(o.features) ? o.features : [];
    const btnText = esc(o.btn_text || '立即预约');
    // booking.js 通过 data-offer 兼容旧名称映射；动态优惠优先使用 offer_key 作为预约 source
    const dataOffer = esc(o.name || '');
    const dataSource = esc(o.offer_key || o.source || 'promo');
    const dataDisplay = esc(o.name || '优惠抢购');

    const featureItems = features.map(f =>
        `<li><i class="fas fa-check"></i> ${esc(f)}</li>`
    ).join('');

    return `
        <div class="offer-card ${theme} animate-on-scroll in" data-offer-id="${o.id}">
            <i class="fas ${esc(icon)} icon"></i>
            <h3>${name}</h3>
            <div class="price-big">${price}</div>
            <div class="price-cmp">${cmp}${suffix ? (cmp ? ' · ' : '') + suffix : ''}</div>
            <ul>${featureItems}</ul>
            <button class="offer-btn"
                    data-offer="${dataOffer}"
                    data-source="${dataSource}"
                    data-display="${dataDisplay}">${btnText}</button>
        </div>
    `;
}

function renderOffers(grid, offers) {
    if (!grid) return;
    if (!offers || offers.length === 0) {
        grid.innerHTML = `
            <div class="offer-empty" style="grid-column: 1/-1; text-align:center; padding: 32px 16px; color:#94a3b8;">
                <i class="fas fa-tag" style="font-size:28px; opacity:.6;"></i>
                <p style="margin-top:8px;">暂无优惠活动</p>
            </div>
        `;
        return;
    }
    grid.innerHTML = offers.map((o, i) => buildOfferCard(o, i)).join('');
}

async function fetchOffers() {
    const resp = await fetch(OFFERS_ENDPOINT, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    if (result.code !== 0) throw new Error(result.message || '获取优惠失败');
    return Array.isArray(result.data) ? result.data.map(normalizeOffer) : [];
}

export async function initOffers() {
    const section = document.getElementById('offers');
    if (!section) return;
    const grid = section.querySelector('.offer-grid');
    if (!grid) return;

    // 兼容历史：data-source 传递 booking.js 的优惠按钮分支
    // booking.js 中 .offer-btn 点击会读取 data-offer 进入 OFFER_TO_SOURCE 映射；
    // 我们在 buildOfferCard 中保留 data-offer，且通过 booking.js 的事件分发支持
    // 同步给一次"加载中"占位（避免闪烁）
    grid.dataset.loading = '1';
    grid.innerHTML = `
        <div class="offer-loading" style="grid-column: 1/-1; text-align:center; padding: 32px 16px; color:#94a3b8;">
            <i class="fas fa-spinner fa-spin" style="font-size:24px;"></i>
            <p style="margin-top:8px;">正在加载优惠活动…</p>
        </div>
    `;

    try {
        const offers = await fetchOffers();
        renderOffers(grid, offers);
    } catch (e) {
        console.error('[offers] 加载优惠失败:', e);
        // 失败时保留首页内容尽量不空白；展示简单错误占位
        grid.innerHTML = `
            <div class="offer-error" style="grid-column: 1/-1; text-align:center; padding: 32px 16px; color:#ef4444;">
                <i class="fas fa-circle-exclamation" style="font-size:24px;"></i>
                <p style="margin-top:8px;">优惠活动加载失败，请稍后重试</p>
            </div>
        `;
    } finally {
        grid.dataset.loading = '0';
    }

    // 暴露刷新接口，便于在管理后台保存后跨页面提示
    window.__refreshOffers = async () => {
        try {
            const offers = await fetchOffers();
            renderOffers(grid, offers);
        } catch (e) {
            console.warn('[offers] 刷新失败:', e);
        }
    };

    // 监听其它标签页发出的"offers-updated"广播
    window.addEventListener('storage', (e) => {
        if (e.key === 'yx_offers_updated') {
            window.__refreshOffers && window.__refreshOffers();
        }
    });
}
