// 导航：锚点平滑滚动、导航到店、点击复制
export function initNavigation() {
    document.querySelectorAll('a[href^="#"]').forEach(link => {
        link.addEventListener('click', e => {
            const href = link.getAttribute('href');
            if (!href || href === '#') return;
            const target = document.querySelector(href);
            if (target) {
                e.preventDefault();
                const navOffset = 70;
                const top = target.getBoundingClientRect().top + window.scrollY - navOffset;
                window.scrollTo({ top, behavior: 'smooth' });
            }
        });
    });

    const navBtn = document.getElementById('navBtn');
    if (navBtn) {
        navBtn.addEventListener('click', () => {
            const target = encodeURIComponent('深圳市南山区科技园南区');
            const url = `https://uri.amap.com/marker?name=${target}&coordinate=gaode`;
            window.open(url, '_blank', 'noopener');
        });
    }

    // 通用点击复制：任何带 [data-copy] 的元素，点击即把 data-copy 的值复制到剪贴板
    // 特殊处理：tel: 链接在移动端保留拨号能力，仅在桌面端阻止默认行为
    document.addEventListener('click', async (e) => {
        const el = e.target.closest('[data-copy]');
        if (!el) return;

        // 判断是否移动端（tel: 链接在移动端不拦截）
        const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
        const isTelLink = el.tagName === 'A' && (el.getAttribute('href') || '').startsWith('tel:');

        if (!(isMobile && isTelLink)) {
            e.preventDefault();
        }

        const text = el.dataset.copy || el.textContent.trim();
        const ok = await copyToClipboard(text);
        // 视觉反馈：选中文字 + Toast
        selectText(el.querySelector('.wechat-id') || el);
        showCopyToast(ok ? `已复制：${text}` : '复制失败，请手动选择复制', ok ? 'success' : 'error');
        // 高亮动画
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 1200);
    });
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        // 兼容旧浏览器 / 非 https 环境
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

function selectText(el) {
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function showCopyToast(message, type = 'success') {
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
