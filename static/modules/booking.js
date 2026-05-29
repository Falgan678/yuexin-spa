// 预约模块 - 弹窗、表单提交、外部触发
import { http, BizError } from './http.js';
import { toast } from './toast.js';
import { BASE_BOOKING_SOURCES, normalizeOffer, validateBookingPayload } from './schema.js';

export function initBooking() {
    const bookingModal = document.getElementById('bookingModal');
    const closeModalBtn = document.getElementById('closeModal');
    const bookingForm = document.getElementById('bookingForm');

    if (!bookingModal || !bookingForm) return;

    const serviceDisplay = document.getElementById('bookingServiceDisplay');
    const allowedSources = new Set(BASE_BOOKING_SOURCES);
    loadBookingSources();

    // 当前预约携带的上下文
    const ctx = {
        serviceType: '',  // 真实服务名（如 "经络推拿"），后端白名单字段
        category: '',     // 分类 id（chinese/thai/aroma/foot）
        source: 'normal', // 来源：normal / new_customer / member / couple_package / promo
        display: '',      // 给用户看的标题
    };

    // 优惠按钮 -> source 映射（兼容旧静态优惠，动态优惠优先使用 offer_key）
    const OFFER_TO_SOURCE = {
        '新客体验价': 'new_customer',
        '会员套餐':   'member',
        '双人套餐':   'couple_package',
    };

    async function loadBookingSources() {
        try {
            const result = await http.get('/api/offers', { silent: true, retries: 1 });
            (result?.data || []).map(normalizeOffer).forEach(o => {
                if (o.offer_key) allowedSources.add(o.offer_key);
                if (o.source) allowedSources.add(o.source);
            });
        } catch { /* 失败时使用基础来源，后端仍会最终校验 */ }
    }

    function openBookingModal({ serviceType = '', category = '', source = 'normal', display = '' } = {}) {
        ctx.serviceType = serviceType;
        ctx.category = category;
        ctx.source = source || 'normal';
        ctx.display = display || serviceType || '';
        if (ctx.source) allowedSources.add(ctx.source);
        bookingModal.classList.add('active');
        document.body.style.overflow = 'hidden';
        if (serviceDisplay) {
            serviceDisplay.textContent = ctx.display || '请选择服务项目';
            serviceDisplay.classList.toggle('placeholder', !ctx.display);
        }
    }

    function closeBookingModal() {
        bookingModal.classList.remove('active');
        document.body.style.overflow = '';
    }

    // 点击服务卡片"立即预约"按钮
    document.addEventListener('click', e => {
        const btn = e.target.closest('.book-btn');
        if (!btn) return;
        e.preventDefault();
        const card = btn.closest('.service-card');
        const serviceName = card?.dataset.service || '';
        const category = card?.dataset.category || '';
        openBookingModal({
            serviceType: serviceName,
            category,
            source: 'normal',
            display: serviceName,
        });
    });

    // 优惠按钮
    document.addEventListener('click', e => {
        const btn = e.target.closest('.offer-btn');
        if (!btn) return;
        e.preventDefault();
        const offerLabel = btn.dataset.offer || '';
        // 优先使用按钮自身声明的 data-source（来自后台动态优惠卡片）
        // 否则按名称走旧的内置映射，最后兜底为 'promo'
        const src = btn.dataset.source || OFFER_TO_SOURCE[offerLabel] || 'promo';
        const display = btn.dataset.display || offerLabel || '优惠抢购';
        openBookingModal({
            serviceType: '',
            category: '',
            source: src,
            display,
        });
    });

    // 通用预约触发器：[data-action="book"]（顶部"立即预约"、Hero"一键预约"等）
    document.addEventListener('click', e => {
        const btn = e.target.closest('[data-action="book"]');
        if (!btn) return;
        e.preventDefault();
        openBookingModal({
            serviceType: btn.dataset.service || '',
            category: btn.dataset.category || '',
            source: btn.dataset.source || 'normal',
            display: btn.dataset.display || btn.dataset.service || '',
        });
    });

    // 外部事件触发（详情页"立即预约"）
    document.addEventListener('open-booking', e => {
        const { serviceType = '', serviceDisplay = '', category = '', source = 'normal' } = e.detail || {};
        openBookingModal({ serviceType, category, source, display: serviceDisplay });
    });

    if (closeModalBtn) closeModalBtn.addEventListener('click', closeBookingModal);
    bookingModal.addEventListener('click', e => {
        if (e.target === bookingModal) closeBookingModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && bookingModal.classList.contains('active')) closeBookingModal();
    });

    bookingForm.addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(bookingForm);
        const data = {
            name: (fd.get('name') || '').trim(),
            phone: (fd.get('phone') || '').trim(),
            datetime: fd.get('datetime'),
            note: (fd.get('note') || '').trim() || '',
            service_type: ctx.serviceType || null,
            category: ctx.category || null,
            source: ctx.source || 'normal',
        };

        // 客户端校验（与后端 Pydantic 规则保持一致）
        const validationError = validateBookingPayload(data, { allowedSources });
        if (validationError) return showMessage(validationError, 'error');

        showLoading();
        // POST 默认不重试，避免重复下单；但 408/超时单次重试可由 http 层根据 retryMethods 配置
        // 这里显式指定：silent=true 自己接管 toast，让成功提示与失败语义可定制
        try {
            const result = await http.post('/api/bookings', data, { silent: true, retries: 0 });
            hideLoading();
            toast.success(result?.message || '预约成功！我们会尽快与您联系确认');
            bookingForm.reset();
            // 本地缓存常用信息，下次自动回填
            try {
                localStorage.setItem('yx_last_booker', JSON.stringify({
                    name: data.name, phone: data.phone,
                }));
            } catch {}
            setTimeout(closeBookingModal, 1200);
        } catch (err) {
            hideLoading();
            const msg = (err instanceof BizError && err.message)
                ? err.message
                : '网络异常，请检查网络后重试';
            // 5xx 给出更明确的引导文案
            if (err instanceof BizError && err.status >= 500) {
                toast.error(`服务暂时繁忙，请稍后重试（${err.status}）`);
            } else if (err instanceof BizError && err.status === 0) {
                toast.error('网络连接异常，请检查网络后重试');
            } else {
                toast.error(msg);
            }
            console.error('预约提交失败:', err);
        }
    });

    // 自动回填上次预约人信息
    try {
        const cached = JSON.parse(localStorage.getItem('yx_last_booker') || 'null');
        if (cached) {
            const ni = bookingForm.querySelector('input[name="name"], input[type="text"]');
            const pi = bookingForm.querySelector('input[name="phone"], input[type="tel"]');
            if (ni && !ni.value) ni.value = cached.name || '';
            if (pi && !pi.value) pi.value = cached.phone || '';
        }
    } catch {}

    function showMessage(message, type = 'info') {
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i><span></span>`;
        el.querySelector('span').textContent = message;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.parentNode && el.parentNode.removeChild(el), 300);
        }, 2400);
    }

    function showLoading() {
        const btn = bookingForm.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.dataset.original = btn.innerHTML; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 提交中...'; }
    }
    function hideLoading() {
        const btn = bookingForm.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.original || '确认预约'; }
    }

    window.addEventListener('storage', (e) => {
        if (e.key === 'yx_offers_updated') loadBookingSources();
    });

    // 手机号实时提示
    const phoneInput = bookingForm.querySelector('input[type="tel"]');
    if (phoneInput) {
        phoneInput.addEventListener('input', e => {
            const v = e.target.value;
            phoneInput.setCustomValidity(v && !/^1[3-9]\d{9}$/.test(v) ? '请输入正确的手机号码' : '');
        });
    }
}
