// 主入口：组装所有模块
import { initMenu } from './modules/menu.js';
import { initScrollEffects } from './modules/scroll.js';
import { initServices } from './modules/services.js';
import { initBooking } from './modules/booking.js';
import { initNavigation } from './modules/navigation.js';
import { initAnalytics } from './modules/analytics.js';
import { initContact } from './modules/contact.js';
import { initPhoneModal } from './modules/phone-modal.js';
import { initEnvironment } from './modules/environment.js';
import { initOffers } from './modules/offers.js';
import { initialSkeleton } from './modules/skeleton.js';
import { toast } from './modules/toast.js';

// 任何一个 init 出错都不应该阻断后续的，避免一个模块的 bug 把整个首页 JS 链路废掉
function safeRun(name, fn) {
    try {
        const ret = fn();
        if (ret && typeof ret.catch === 'function') {
            ret.catch(err => {
                console.error(`[init:${name}] async error:`, err);
                if (name === 'services' || name === 'environment' || name === 'offers') {
                    toast.error(`「${name}」模块加载失败，请刷新重试`);
                }
            });
        }
    } catch (err) {
        console.error(`[init:${name}] error:`, err);
        toast.error(`「${name}」初始化异常`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // 1) 立即启动骨架屏控制器（最先执行，确保占位可见）
    safeRun('skeleton',     initialSkeleton);

    // 2) 各业务模块初始化
    safeRun('menu',         initMenu);
    safeRun('scroll',       initScrollEffects);
    safeRun('services',     initServices);
    safeRun('booking',      initBooking);
    safeRun('navigation',   initNavigation);
    safeRun('contact',      initContact);
    safeRun('phoneModal',   initPhoneModal);
    safeRun('environment',  initEnvironment);
    safeRun('offers',       initOffers);
    safeRun('analytics',    initAnalytics);
    document.body.classList.add('loaded');
});

// 全局错误兜底：未捕获的异常 / Promise rejection 也给用户一个 toast，避免静默白屏
window.addEventListener('error', (e) => {
    // 仅对脚本错误兜底，资源加载错误（图片 404）忽略
    if (e && e.message && !(e.target instanceof HTMLElement)) {
        console.error('[global error]', e.message);
    }
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e.reason);
    // 不主动 toast，避免重复（http.js 已统一兜底）
});

