// 电话拨号弹窗模块
// 拦截所有带 data-call="trigger" 的元素（联系区"一键拨号"按钮、右下角悬浮电话），
// 改为弹出统一的"门店咨询电话"卡片；提供复制号码、立即拨打、ESC/遮罩关闭。
const ENDPOINT = '/api/contact-info';

let phoneNumber = '400-888-8888';
let businessHours = '10:00 - 22:00';
let modalEl = null;
let numberEl = null;
let hoursEl = null;
let callBtn = null;
let copyBtn = null;
let lastFocused = null;

export function initPhoneModal() {
    modalEl  = document.getElementById('phoneModal');
    if (!modalEl) return;

    numberEl = document.getElementById('phoneModalNumber');
    hoursEl  = document.getElementById('phoneModalHours');
    callBtn  = document.getElementById('phoneModalCall');
    copyBtn  = modalEl.querySelector('.phone-copy-btn');
    const closeBtn   = modalEl.querySelector('.phone-close');
    const numberWrap = modalEl.querySelector('.phone-number');

    // 异步加载真实电话/营业时间
    loadContactInfo();

    // 拦截一键拨号触发点（联系区按钮 + 浮动电话图标）
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('[data-call="trigger"]');
        if (!trigger) return;
        e.preventDefault();
        openModal();
    });

    // 关闭：✕ 按钮 / 点击遮罩 / ESC
    closeBtn?.addEventListener('click', closeModal);
    modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalEl.classList.contains('show')) closeModal();
    });

    // 复制号码（点击号码或复制按钮均可）
    const copyHandler = async () => {
        const ok = await copyToClipboard(phoneNumber);
        showToast(ok ? `已复制：${phoneNumber}` : '复制失败，请手动选择复制', ok ? 'success' : 'error');
        if (ok && copyBtn) {
            copyBtn.classList.add('copied');
            setTimeout(() => copyBtn.classList.remove('copied'), 1200);
        }
    };
    copyBtn?.addEventListener('click', copyHandler);
    numberWrap?.addEventListener('click', copyHandler);

    // 立即拨打：触发 tel:（移动端唤起拨号；桌面端通常会询问默认应用）
    callBtn?.addEventListener('click', () => {
        window.location.href = `tel:${phoneNumber}`;
    });
}

async function loadContactInfo() {
    try {
        const resp = await fetch(ENDPOINT, { cache: 'no-store' });
        const result = await resp.json();
        if (result.code !== 0) return;
        const items = result.data || [];
        const phone = items.find(i => i.key === 'contact_phone' || i.type === 'phone');
        const hours = items.find(i => i.key === 'contact_hours');
        if (phone?.value) {
            phoneNumber = phone.value;
            if (numberEl) numberEl.textContent = phoneNumber;
            // 同步联系区"一键拨号"按钮 href（保持移动端可识别为电话）
            const contactBtn = document.getElementById('contactCallBtn');
            if (contactBtn) contactBtn.setAttribute('href', `tel:${phoneNumber}`);
            // 同步浮动按钮 href
            document.querySelectorAll('.floating a[data-call="trigger"]').forEach(a => {
                a.setAttribute('href', `tel:${phoneNumber}`);
            });
        }
        if (hours?.value) {
            businessHours = hours.value;
            if (hoursEl) hoursEl.textContent = businessHours;
        }
    } catch (_) {
        // 静默失败，使用默认值
    }
}

function openModal() {
    if (!modalEl) return;
    lastFocused = document.activeElement;
    modalEl.classList.add('show');
    document.body.style.overflow = 'hidden';
    // 焦点移到关闭或拨打
    requestAnimationFrame(() => callBtn?.focus({ preventScroll: true }));
}

function closeModal() {
    if (!modalEl) return;
    modalEl.classList.remove('show');
    document.body.style.overflow = '';
    if (lastFocused && typeof lastFocused.focus === 'function') {
        try { lastFocused.focus({ preventScroll: true }); } catch (_) {}
    }
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch (_) {
        return false;
    }
}

function showToast(message, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i><span></span>`;
    el.querySelector('span').textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.parentNode && el.parentNode.removeChild(el), 300);
    }, 2200);
}
