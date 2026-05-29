/**
 * 骨架屏控制器
 * ============================================================
 * 功能：
 *   1) initialSkeleton(): DOMContentLoaded 后立即显示首屏骨架（services / environment / offers）
 *   2) hideInitialSkeleton(): 当对应模块完成首次渲染或全部超时后隐藏
 *   3) hideOnTimeout(ms): 弱网兜底，避免骨架永久存在
 *
 * 设计：
 *   - 骨架占位通过 [data-skeleton] 与对应 module 的容器一一对应
 *   - 容器内首次出现真实卡片时（MutationObserver）自动隐藏对应骨架
 *   - 超时（默认 8s）强制隐藏所有骨架并显示"加载失败"占位
 */

const SKELETON_TARGETS = [
    { skeleton: 'skeleton-services',    real: 'serviceGrid', fallbackTip: '服务项目加载失败，请刷新页面' },
    { skeleton: 'skeleton-environment', real: 'envGrid',     fallbackTip: '环境展示加载失败' },
    { skeleton: 'skeleton-offers',      real: 'offerGrid',   fallbackTip: '优惠活动加载失败' },
];

function hideEl(el) {
    if (!el) return;
    el.classList.add('skeleton-hidden');
    setTimeout(() => { el.style.display = 'none'; }, 320);
}

function showFallback(el, tip) {
    if (!el) return;
    el.innerHTML = `
        <div class="skeleton-fallback">
            <i class="fas fa-cloud-exclamation"></i>
            <p>${tip}</p>
            <button type="button" class="skeleton-retry" onclick="location.reload()">
                <i class="fas fa-rotate-right"></i> 重新加载
            </button>
        </div>`;
}

export function hideSkeleton(skeletonId) {
    const el = document.getElementById(skeletonId);
    if (el && !el.classList.contains('skeleton-hidden')) hideEl(el);
}

/**
 * 监听真实容器的子节点出现，自动隐藏对应骨架
 */
export function initialSkeleton() {
    SKELETON_TARGETS.forEach(({ skeleton, real }) => {
        const skEl = document.getElementById(skeleton);
        const realEl = document.getElementById(real);
        if (!skEl || !realEl) return;

        // 已经有内容直接隐藏
        if (realEl.children.length > 0 && realEl.dataset.loaded === 'true') {
            hideEl(skEl);
            return;
        }

        const observer = new MutationObserver(() => {
            // 真实容器内出现非空节点时认为加载完成
            const hasReal = Array.from(realEl.children).some(
                node => !node.classList || !node.classList.contains('placeholder')
            );
            if (hasReal) {
                hideEl(skEl);
                observer.disconnect();
            }
        });
        observer.observe(realEl, { childList: true, subtree: false });
    });

    // 8s 兜底超时
    hideOnTimeout(8000);
}

export function hideOnTimeout(ms = 8000) {
    setTimeout(() => {
        SKELETON_TARGETS.forEach(({ skeleton, real, fallbackTip }) => {
            const skEl = document.getElementById(skeleton);
            const realEl = document.getElementById(real);
            if (!skEl) return;
            if (skEl.classList.contains('skeleton-hidden')) return;
            // 真实容器仍空 → 展示降级提示
            if (realEl && realEl.children.length === 0) {
                hideEl(skEl);
                showFallback(realEl, fallbackTip);
            } else {
                hideEl(skEl);
            }
        });
    }, ms);
}
