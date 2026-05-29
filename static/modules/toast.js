/**
 * 全局 Toast 提示组件 · 单例
 * ============================================================
 * - 复用项目已有 .toast / .toast-success / .toast-error / .toast-info 样式
 * - 提供 success / error / warning / info / loading 五种语义
 * - 支持手动 dismiss（loading 场景）
 * - 多条同时存在时自动堆叠（垂直方向，间距 12px）
 * - 暴露 window.YxToast 便于跨模块直接调用
 *
 * 使用：
 *   import { toast } from './toast.js';
 *   toast.success('预约成功');
 *   toast.error('网络异常');
 *   const t = toast.loading('提交中…'); t.dismiss();
 */

const HOLD_MS = 2600;       // 默认显示时长
const STACK_GAP = 12;       // 堆叠间距 px
const TOP_OFFSET = 90;      // 顶部起始位置（与导航栏避让）

const stack = [];

function getIcon(type) {
    switch (type) {
        case 'success': return 'fa-check-circle';
        case 'error':   return 'fa-exclamation-circle';
        case 'warning': return 'fa-exclamation-triangle';
        case 'loading': return 'fa-spinner fa-spin';
        default:        return 'fa-info-circle';
    }
}

function relayout() {
    let top = TOP_OFFSET;
    stack.forEach(el => {
        el.style.top = `${top}px`;
        top += el.offsetHeight + STACK_GAP;
    });
}

function show(message, type = 'info', duration = HOLD_MS) {
    const el = document.createElement('div');
    // warning 走 error 视觉变体；loading 走 info；保持 CSS 兼容
    const cssType =
        type === 'warning' ? 'error' :
        type === 'loading' ? 'info'  : type;
    el.className = `toast toast-${cssType}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

    const icon = document.createElement('i');
    icon.className = `fas ${getIcon(type)}`;
    const span = document.createElement('span');
    span.textContent = String(message ?? '');
    el.appendChild(icon);
    el.appendChild(span);

    document.body.appendChild(el);
    stack.push(el);
    requestAnimationFrame(() => {
        el.classList.add('show');
        relayout();
    });

    let dismissed = false;
    function dismiss() {
        if (dismissed) return;
        dismissed = true;
        el.classList.remove('show');
        const idx = stack.indexOf(el);
        if (idx >= 0) stack.splice(idx, 1);
        relayout();
        setTimeout(() => {
            el.parentNode && el.parentNode.removeChild(el);
        }, 320);
    }

    let timer = null;
    if (duration > 0) timer = setTimeout(dismiss, duration);

    return {
        dismiss() {
            if (timer) clearTimeout(timer);
            dismiss();
        },
        update(newMsg, newType) {
            span.textContent = String(newMsg ?? '');
            if (newType && newType !== type) {
                el.className = `toast toast-${newType === 'warning' ? 'error' : (newType === 'loading' ? 'info' : newType)} show`;
                icon.className = `fas ${getIcon(newType)}`;
            }
        },
    };
}

export const toast = {
    success: (m, d) => show(m, 'success', d),
    error:   (m, d) => show(m, 'error',   d ?? 3200),
    warning: (m, d) => show(m, 'warning', d),
    info:    (m, d) => show(m, 'info',    d),
    loading: (m)    => show(m, 'loading', 0), // 不自动消失，需调 dismiss()
};

// 便于其他非模块脚本（如内联 onerror）调用
if (typeof window !== 'undefined') {
    window.YxToast = toast;
}
