// 滚动效果：导航变色 / 返回顶部 / 元素渐入
export function initScrollEffects() {
    const nav = document.getElementById('siteNav');
    const scrollTop = document.getElementById('scrollTop');

    function onScroll() {
        const y = window.scrollY;
        if (nav) nav.classList.toggle('scrolled', y > 16);
        if (scrollTop) scrollTop.classList.toggle('show', y > 320);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (scrollTop) {
        scrollTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    }

    // 渐入
    const els = document.querySelectorAll('.animate-on-scroll');
    if ('IntersectionObserver' in window && els.length) {
        const io = new IntersectionObserver(entries => {
            entries.forEach(e => {
                if (e.isIntersecting) {
                    e.target.classList.add('in');
                    io.unobserve(e.target);
                }
            });
        }, { threshold: 0.15 });
        els.forEach(el => io.observe(el));
    } else {
        els.forEach(el => el.classList.add('in'));
    }
}
