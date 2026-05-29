// 前端数据契约与校验规则：与 main.py 的 Pydantic 模型保持同步

export const REGEX = {
    phone: /^1[3-9]\d{9}$/,
    businessPhone: /^(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|400-?\d{3}-?\d{4}|800-?\d{3}-?\d{4})$/,
    customId: /^[\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,20}$/,
    serviceId: /^[A-Za-z][A-Za-z0-9_-]{1,39}$/,
    offerKey: /^[a-z][a-z0-9_]{1,39}$/,
    safeClassToken: /^[A-Za-z0-9_-]+$/,
};

export const LIMITS = {
    bookingName: 50,
    bookingNote: 500,
    serviceName: 50,
    serviceSubtitle: 120,
    serviceImage: 500,
    serviceDurationMin: 10,
    serviceDurationMax: 300,
    servicePriceMin: 1,
    servicePriceMax: 99999,
    servicePopularityMin: 0,
    servicePopularityMax: 100,
    serviceSuitableFor: 120,
    serviceDescription: 1000,
    offerName: 50,
    offerPrice: 40,
    offerOriginalPrice: 80,
    offerPriceSuffix: 120,
    offerFeature: 60,
    offerFeatureMaxCount: 8,
};

export const BASE_BOOKING_SOURCES = new Set([
    'normal', 'new_customer', 'member', 'couple_package', 'flash_sale', 'promo',
]);

export function toStr(value, fallback = '') {
    return String(value ?? fallback).trim();
}

export function toInt(value, fallback = 0) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

export function clampInt(value, min, max, fallback = min) {
    return Math.max(min, Math.min(max, toInt(value, fallback)));
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
}

export function safeClassTokens(value, fallback = '') {
    const tokens = String(value ?? '').trim().split(/\s+/).filter(Boolean);
    const safe = tokens.filter(t => REGEX.safeClassToken.test(t));
    return safe.length ? safe.join(' ') : fallback;
}

export function sanitizeFaIcon(value, fallback = 'fa-circle-info') {
    const safe = safeClassTokens(value, fallback);
    return safe || fallback;
}

export function normalizeMetaCategory(raw = {}) {
    const id = toStr(raw.id);
    return {
        id,
        name: toStr(raw.name || id),
        icon: sanitizeFaIcon(raw.icon, 'fa-tag'),
        builtin: Boolean(raw.builtin),
        sort_order: toInt(raw.sort_order, 100),
    };
}

export function normalizeMetaTag(raw = {}) {
    const id = toStr(raw.id);
    return {
        id,
        label: toStr(raw.label || id),
        color: safeClassTokens(raw.color, 'bg-slate-500'),
        builtin: Boolean(raw.builtin),
        sort_order: toInt(raw.sort_order, 100),
    };
}

export function normalizeService(raw = {}) {
    return {
        id: toStr(raw.id),
        name: toStr(raw.name),
        subtitle: toStr(raw.subtitle),
        category: toStr(raw.category),
        image: toStr(raw.image),
        duration: clampInt(raw.duration, LIMITS.serviceDurationMin, LIMITS.serviceDurationMax, 60),
        price: clampInt(raw.price, LIMITS.servicePriceMin, LIMITS.servicePriceMax, 1),
        originalPrice: clampInt(raw.original_price ?? raw.originalPrice, 0, LIMITS.servicePriceMax, 0),
        popularity: clampInt(raw.popularity, LIMITS.servicePopularityMin, LIMITS.servicePopularityMax, 50),
        tags: Array.isArray(raw.tags) ? raw.tags.map(toStr).filter(Boolean).slice(0, 20) : [],
        effects: Array.isArray(raw.effects) ? raw.effects.map(toStr).filter(Boolean).slice(0, 10) : [],
        suitableFor: toStr(raw.suitable_for ?? raw.suitableFor).slice(0, LIMITS.serviceSuitableFor),
        description: toStr(raw.description).slice(0, LIMITS.serviceDescription),
        contactPhone: toStr(raw.contact_phone ?? raw.contactPhone),
    };
}

export function normalizeOffer(raw = {}) {
    const key = toStr(raw.offer_key).toLowerCase();
    return {
        id: toInt(raw.id, 0),
        offer_key: key,
        name: toStr(raw.name).slice(0, LIMITS.offerName),
        icon: sanitizeFaIcon(raw.icon, 'fa-gift'),
        theme: /^offer-(?:[1-9]|1[0-2])$/.test(toStr(raw.theme)) ? toStr(raw.theme) : 'offer-1',
        price: toStr(raw.price).slice(0, LIMITS.offerPrice),
        original_price: toStr(raw.original_price).slice(0, LIMITS.offerOriginalPrice),
        price_suffix: toStr(raw.price_suffix).slice(0, LIMITS.offerPriceSuffix),
        features: Array.isArray(raw.features) ? raw.features.map(toStr).filter(Boolean).slice(0, LIMITS.offerFeatureMaxCount) : [],
        btn_text: toStr(raw.btn_text || '立即预约').slice(0, 40),
        source: toStr(raw.source || 'promo'),
        is_active: Boolean(raw.is_active),
        sort_order: toInt(raw.sort_order, 100),
        updated_at: raw.updated_at || '',
    };
}

export function validateBookingPayload(data, { allowedSources = BASE_BOOKING_SOURCES } = {}) {
    const name = toStr(data.name);
    const phone = toStr(data.phone);
    const note = toStr(data.note);
    const source = toStr(data.source || 'normal');
    const category = toStr(data.category);
    const serviceType = toStr(data.service_type);

    if (!name) return '请填写姓名';
    if (name.length > LIMITS.bookingName) return `姓名过长（不超过 ${LIMITS.bookingName} 字）`;
    if (!REGEX.phone.test(phone)) return '请输入正确的手机号码';
    if (!data.datetime) return '请选择预约时间';
    if (new Date(data.datetime) <= new Date()) return '预约时间必须晚于当前时间';
    if (note.length > LIMITS.bookingNote) return `备注过长（不超过 ${LIMITS.bookingNote} 字）`;
    if (serviceType && serviceType.length > LIMITS.serviceName) return `服务名称过长（不超过 ${LIMITS.serviceName} 字）`;
    if (category && !REGEX.customId.test(category)) return '服务分类格式不正确';
    if (source && !allowedSources.has(source)) return '预约来源无效，请刷新页面后重试';
    return '';
}
