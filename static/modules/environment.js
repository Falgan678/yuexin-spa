/**
 * 环境展示模块 · 流式河流（Stream Carousel）
 * ============================================================
 * 视觉与交互：
 *   - 图片以"河流"形式横向流式排列（无蜂窝/网格）
 *   - 当前活跃图片正面居中、放大突出，背景模糊光晕烘托
 *   - 两侧图片自动缩小、旋转、弱化（透明度 + 灰度），形成纵深感
 *   - 自动轮播（4.5s 切换一张）+ 鼠标进入暂停 / 离开恢复
 *   - 手动控制：左右按钮 / 圆点指示器 / 键盘 ← → / 鼠标滚轮 / 拖拽滑动
 *   - 点击任意图片 → 全屏 Lightbox 查看原图
 *   - Lightbox 支持：左右点击切换 / 滑动手势 / 键盘 ← → / Esc 关闭
 *
 * 性能保证：
 *   - 单一 RAF 主循环驱动所有变换
 *   - 仅 transform / opacity / filter，零 layout 抖动
 *   - 视口外暂停 RAF 与自动播放
 *   - prefers-reduced-motion 兼容
 */

const API_URL = '/api/environments';

const IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const AUTOPLAY_INTERVAL = 4500; // 自动轮播间隔 ms

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const lerp  = (a, b, t) => a + (b - a) * t;

// ============================================================
// StreamCarousel：横向流式轮播（中心放大 / 两侧弱化）
// ============================================================
class StreamCarousel {
    constructor(host, items, meta) {
        this.host = host;
        this.items = items;
        this.meta = meta || {};
        // 全局停留时间（ms）：来自后端 settings.env_autoplay_ms，兜底 4500
        this.globalAutoplayMs = (() => {
            const v = parseInt(this.meta.env_autoplay_ms, 10);
            return (Number.isFinite(v) && v >= 500 && v <= 60000) ? v : AUTOPLAY_INTERVAL;
        })();
        this.root = null;
        this.track = null;
        this.bgLayer = null;          // 背景模糊光晕（取当前活跃图片）
        this.tiles = [];
        this.activeIndex = 0;          // 当前活跃图片索引
        this.targetIndex = 0;          // 目标索引（带平滑过渡）
        this.smoothIndex = 0;          // 当前平滑插值后的"小数索引"
        this.tileW = 0;                // 单张卡片宽度（含 gap）
        this.gap = 30;
        this.rafId = 0;
        this.running = false;
        this.lastTs = 0;
        this.dragging = false;
        this.dragStartX = 0;
        this.dragStartIndex = 0;
        this.lastVx = 0;
        this.lastT = 0;
        this._dragMoved = false;
        this.viewportVisible = true;
        this.autoplayTimer = 0;
        this.autoplayPaused = false;
        this._handlers = [];
    }

    mount() {
        const root = document.createElement('div');
        root.className = 'env-stream';
        this.root = root;

        // 背景模糊层（活跃图片的大图模糊作为环境光）
        this.bgLayer = document.createElement('div');
        this.bgLayer.className = 'env-stream__bg';
        root.appendChild(this.bgLayer);

        // 渐变遮罩（左右淡出）
        const fadeLeft = document.createElement('div');
        fadeLeft.className = 'env-stream__fade env-stream__fade--left';
        const fadeRight = document.createElement('div');
        fadeRight.className = 'env-stream__fade env-stream__fade--right';
        root.appendChild(fadeLeft);
        root.appendChild(fadeRight);

        // 滚动轨道（卡片在 RAF 中通过 transform 各自计算位置）
        const track = document.createElement('div');
        track.className = 'env-stream__track';
        root.appendChild(track);
        this.track = track;

        // 创建每张卡片
        this.items.forEach((it, idx) => {
            const tile = document.createElement('figure');
            tile.className = 'env-stream__tile is-pending';
            tile.dataset.idx = idx;
            tile.innerHTML = `
                <div class="env-stream__inner">
                    <div class="env-stream__media">
                        <img src="${esc(it.image)}" alt="${esc(it.alt || it.title || '')}"
                             loading="lazy" decoding="async" draggable="false">
                        <div class="env-stream__shine"></div>
                    </div>
                    <figcaption class="env-stream__caption">
                        <span class="env-stream__index">${String(idx + 1).padStart(2, '0')} / ${String(this.items.length).padStart(2, '0')}</span>
                        <h4 class="env-stream__title">${esc(it.title || '')}</h4>
                        ${it.description ? `<p class="env-stream__desc">${esc(it.description)}</p>` : ''}
                        <span class="env-stream__zoom"><i class="fas fa-expand"></i> 点击查看大图</span>
                    </figcaption>
                </div>
            `;
            // 注：tile 的点击逻辑统一由 track 的 pointerup 兜底处理
            // （setPointerCapture 后浏览器不一定派发 click 到 tile，所以不依赖 click 事件）
            track.appendChild(tile);
            this.tiles.push({ el: tile, idx });
        });

        // 左右导航按钮
        const navL = document.createElement('button');
        navL.type = 'button';
        navL.className = 'env-stream__nav env-stream__nav--prev';
        navL.setAttribute('aria-label', '上一张');
        navL.innerHTML = '<i class="fas fa-chevron-left"></i>';
        navL.addEventListener('click', () => this._step(-1));
        root.appendChild(navL);

        const navR = document.createElement('button');
        navR.type = 'button';
        navR.className = 'env-stream__nav env-stream__nav--next';
        navR.setAttribute('aria-label', '下一张');
        navR.innerHTML = '<i class="fas fa-chevron-right"></i>';
        navR.addEventListener('click', () => this._step(1));
        root.appendChild(navR);

        // 自动播放控制按钮
        const autoBtn = document.createElement('button');
        autoBtn.type = 'button';
        autoBtn.className = 'env-stream__autoplay';
        autoBtn.setAttribute('aria-label', '暂停/播放');
        autoBtn.innerHTML = '<i class="fas fa-pause"></i>';
        autoBtn.addEventListener('click', () => {
            this.autoplayPaused = !this.autoplayPaused;
            autoBtn.classList.toggle('is-paused', this.autoplayPaused);
            autoBtn.innerHTML = this.autoplayPaused
                ? '<i class="fas fa-play"></i>'
                : '<i class="fas fa-pause"></i>';
        });
        this.autoBtn = autoBtn;
        root.appendChild(autoBtn);

        // 圆点指示器
        const dots = document.createElement('div');
        dots.className = 'env-stream__dots';
        this.items.forEach((_, i) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'env-stream__dot' + (i === 0 ? ' is-active' : '');
            dot.setAttribute('aria-label', `切到第 ${i + 1} 张`);
            dot.addEventListener('click', () => this._goto(i));
            dots.appendChild(dot);
        });
        root.appendChild(dots);
        this.dots = dots;

        this.host.appendChild(root);

        // 入场动画
        requestAnimationFrame(() => {
            this.tiles.forEach((t, i) => {
                setTimeout(() => t.el.classList.add('in-view'), i * 80);
            });
            this._measure();
            this._updateBg();
        });

        // 监听 resize
        const onResize = () => this._measure();
        window.addEventListener('resize', onResize);
        this._handlers.push([window, 'resize', onResize]);

        // 鼠标悬停暂停自动播放
        const onEnter = () => { this._hoverPause = true; };
        const onLeave = () => { this._hoverPause = false; };
        root.addEventListener('mouseenter', onEnter);
        root.addEventListener('mouseleave', onLeave);

        // 鼠标滚轮 → 横向切换（节流）
        let wheelLock = false;
        const onWheel = (e) => {
            const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            if (Math.abs(delta) < 6) return;
            e.preventDefault();
            if (wheelLock) return;
            wheelLock = true;
            this._step(delta > 0 ? 1 : -1);
            setTimeout(() => { wheelLock = false; }, 380);
        };
        root.addEventListener('wheel', onWheel, { passive: false });
        this._handlers.push([root, 'wheel', onWheel]);

        // 拖拽 / 触摸
        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            this.dragging = true;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.dragStartIndex = this.smoothIndex;
            this._dragMoved = false;
            this.lastT = performance.now();
            this.lastVx = 0;
            try { track.setPointerCapture(e.pointerId); } catch {}
            track.classList.add('is-dragging');
        };
        const onMove = (e) => {
            if (!this.dragging) return;
            const dx = e.clientX - this.dragStartX;
            if (Math.abs(dx) > 6) this._dragMoved = true;
            const now = performance.now();
            const dt = Math.max(1, now - this.lastT);
            this.lastVx = -dx * 16 / dt;
            this.lastT = now;
            // 1 张卡片宽度 = 100% 切换距离
            const stepW = this.tileW || 320;
            // 拖拽中允许超出边界（视觉上无限滚动）；松手时再归一
            this.targetIndex = this.dragStartIndex - dx / stepW;
            this.smoothIndex = this.targetIndex; // 拖拽中实时跟随
        };
        const onUp = (e) => {
            if (!this.dragging) return;
            this.dragging = false;
            track.classList.remove('is-dragging');
            const wasDragMoved = this._dragMoved;
            // 释放：根据速度判定要不要再多滑一格
            const flick = Math.abs(this.lastVx) > 0.6;
            const flickDir = this.lastVx > 0 ? 1 : -1;
            const targetRaw = flick
                ? Math.round(this.smoothIndex + flickDir * 0.6)
                : Math.round(this.smoothIndex);
            // 循环归一
            const len = this.items.length;
            const target = len > 0 ? ((targetRaw % len) + len) % len : 0;
            this.targetIndex = target;
            this.activeIndex = target;
            this.smoothIndex = target; // 防止视觉跳跃后再回弹
            this._syncDots();
            this._updateBg();

            // —— 关键：纯点击（未拖拽）时手动派发"点击 tile"逻辑 ——
            // 因为 setPointerCapture 后 click 事件不一定冒泡到 tile，必须在这里兜底
            if (!wasDragMoved && e && typeof e.clientX === 'number') {
                // 注意：这里不能用 e.target（因为 capture 状态下 e.target 是 track）
                // 改用 elementFromPoint 取释放点元素，再向上找 .env-stream__tile
                const x = e.clientX, y = e.clientY;
                const hit = document.elementFromPoint(x, y);
                const tile = hit && hit.closest && hit.closest('.env-stream__tile');
                if (tile && tile.dataset && tile.dataset.idx != null) {
                    const i = Number(tile.dataset.idx);
                    if (i === this.activeIndex) {
                        openLightbox(this.items, i);
                    } else {
                        this._goto(i);
                    }
                }
            }
        };
        track.addEventListener('pointerdown', onDown);
        track.addEventListener('pointermove', onMove);
        track.addEventListener('pointerup', onUp);
        track.addEventListener('pointercancel', onUp);

        // 键盘
        const onKey = (e) => {
            if (!this._isInViewport()) return;
            // 当 Lightbox 打开时让 lightbox 自己处理
            const lb = document.getElementById('envLightbox');
            if (lb && lb.classList.contains('open')) return;
            if (e.key === 'ArrowLeft')  { e.preventDefault(); this._step(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); this._step(1); }
        };
        document.addEventListener('keydown', onKey);
        this._handlers.push([document, 'keydown', onKey]);

        // 视口可见性 → 暂停 RAF 与 autoplay
        if ('IntersectionObserver' in window) {
            const io = new IntersectionObserver(([entry]) => {
                this.viewportVisible = entry.isIntersecting;
                if (this.viewportVisible) { this._start(); this._scheduleAutoplay(); }
                else { this._stop(); this._cancelAutoplay(); }
            }, { threshold: 0 });
            io.observe(root);
            this._sectionIO = io;
        }

        this._start();
        this._scheduleAutoplay();
    }

    _measure() {
        if (!this.tiles.length) return;
        const first = this.tiles[0].el;
        if (!first || !first.isConnected) return; // destroy 后避免 null/孤儿节点
        const r = first.getBoundingClientRect();
        if (r.width > 0) this.tileW = r.width + this.gap;
    }

    _step(dir) {
        // 循环：targetIndex 允许任意整数，渲染时自动绕环
        const len = this.items.length;
        if (len <= 0) return;
        this.targetIndex = this.targetIndex + dir;
        this.activeIndex = ((this.targetIndex % len) + len) % len;
        this._syncDots();
        this._updateBg();
        this._scheduleAutoplay();
    }

    _goto(i) {
        // 显式跳转（圆点点击 / Lightbox 同步）：选择最短弧到目标
        const len = this.items.length;
        if (len <= 0) return;
        const targetMod = ((i % len) + len) % len;
        // 计算最短弧（从当前 smoothIndex 出发的最近副本）
        const cur = this.smoothIndex;
        const curMod = ((cur % len) + len) % len;
        let delta = targetMod - curMod;
        if (delta > len / 2) delta -= len;
        else if (delta < -len / 2) delta += len;
        this.targetIndex = cur + delta;
        this.activeIndex = targetMod;
        this._syncDots();
        this._updateBg();
        this._scheduleAutoplay(); // 重置定时器
    }

    _syncDots() {
        if (!this.dots) return;
        const all = this.dots.children;
        // 把当前活跃图片的"有效停留时间"作为进度条动画时长（CSS 变量驱动）
        const ms = this._getDurationFor(this.activeIndex);
        const cssDur = (ms / 1000).toFixed(2) + 's';
        for (let k = 0; k < all.length; k++) {
            const isActive = k === this.activeIndex;
            all[k].classList.toggle('is-active', isActive);
            if (isActive) {
                // 触发动画重启：先移除 active 时的 ::after 动画，再设置时长
                all[k].style.setProperty('--env-progress-duration', cssDur);
                // 强制 reflow 让动画从头播
                // eslint-disable-next-line no-unused-expressions
                all[k].offsetWidth;
            }
        }
    }

    _updateBg() {
        if (!this.bgLayer) return;
        const it = this.items[this.activeIndex];
        if (!it) return;
        // 用图片大图作背景模糊层（淡入切换）
        const next = document.createElement('div');
        next.className = 'env-stream__bg-img';
        next.style.backgroundImage = `url("${it.image}")`;
        this.bgLayer.appendChild(next);
        // 触发渐显
        requestAnimationFrame(() => next.classList.add('is-show'));
        // 旧背景渐隐后移除
        setTimeout(() => {
            const olds = this.bgLayer.querySelectorAll('.env-stream__bg-img:not(.is-show)');
            olds.forEach(n => n.remove());
            // 多余的旧 .is-show 也要清理
            const all = this.bgLayer.querySelectorAll('.env-stream__bg-img.is-show');
            for (let i = 0; i < all.length - 1; i++) all[i].remove();
        }, 700);
    }

    _isInViewport() {
        if (!this.root) return false;
        const r = this.root.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
    }

    /**
     * 取指定索引图片的"有效停留时间"。
     * - 该图 duration_ms > 0 → 用其独立设置
     * - 否则 → 用全局 globalAutoplayMs
     */
    _getDurationFor(idx) {
        const it = this.items[idx];
        const own = it && parseInt(it.duration_ms, 10);
        if (Number.isFinite(own) && own >= 500 && own <= 60000) return own;
        return this.globalAutoplayMs;
    }

    _scheduleAutoplay() {
        this._cancelAutoplay();
        if (REDUCE_MOTION) return;
        if (this.items.length < 2) return;
        // 用 setTimeout 链式调度，每次根据"下一张要展示的图"的停留时间设定延迟
        // 注意：当前活跃 = activeIndex；播放后要展示的下一张才是真正决定下次切换间隔的图
        // 但用户体感上"当前图停留时间"才是直觉，所以用 activeIndex 的 duration
        const delay = this._getDurationFor(this.activeIndex);
        this.autoplayTimer = setTimeout(() => {
            this.autoplayTimer = 0;
            if (this.autoplayPaused
                || (this._hoverPause && !IS_TOUCH)
                || this.dragging
                || !this.viewportVisible) {
                // 暂停态：500ms 后再尝试，不强行切换
                this.autoplayTimer = setTimeout(() => this._scheduleAutoplay(), 500);
                return;
            }
            const lb = document.getElementById('envLightbox');
            if (lb && lb.classList.contains('open')) {
                this.autoplayTimer = setTimeout(() => this._scheduleAutoplay(), 500);
                return;
            }
            // 切到下一张（保持循环 / 不重复重置自身定时器）
            const len = this.items.length;
            this.targetIndex = this.targetIndex + 1;
            this.activeIndex = ((this.targetIndex % len) + len) % len;
            this._syncDots();
            this._updateBg();
            // 链式调度下一次
            this._scheduleAutoplay();
        }, delay);
    }
    _cancelAutoplay() {
        if (this.autoplayTimer) { clearTimeout(this.autoplayTimer); this.autoplayTimer = 0; }
    }

    _start() {
        if (this.running) return;
        this.running = true;
        this.lastTs = performance.now();
        const tick = (ts) => {
            if (!this.running) return;
            this._tick(ts);
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }
    _stop() {
        this.running = false;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = 0;
    }

    _tick(ts) {
        const dt = Math.min(64, ts - this.lastTs);
        this.lastTs = ts;
        // 平滑跟随 targetIndex
        const t = 1 - Math.exp(-dt / 180);
        this.smoothIndex = lerp(this.smoothIndex, this.targetIndex, t);

        const len = this.items.length || 1;
        // 每张卡片：根据距 smoothIndex 的"环形最近距离" d，计算变换
        for (const tile of this.tiles) {
            // 环形最近距离：把 d 归一到 [-len/2, len/2)
            let d = tile.idx - this.smoothIndex;
            d = ((d % len) + len) % len;
            if (d > len / 2) d -= len;

            const ad = Math.abs(d);
            // 中心：x=0；越远 x 偏移越大（弧形）
            const offsetX = d * (this.tileW || 320) * 0.86;
            // 距离衰减：缩放、旋转、透明度（透明背景下不再用灰度/模糊，避免发暗）
            const scale   = clamp(1 - ad * 0.16, 0.55, 1);
            const rotateY = clamp(-d * 18, -32, 32);
            const tz      = -ad * 60;
            const op      = clamp(1 - ad * 0.22, 0.4, 1); // 透明度衰减更柔和
            const blur    = 0;  // 透明背景下取消模糊
            const gray    = 0;  // 透明背景下取消灰度
            const lift    = ad < 0.5 ? -8 : 0; // 中心抬起 8px

            tile.el.style.transform =
                `translate3d(${offsetX.toFixed(1)}px, ${lift}px, ${tz.toFixed(1)}px) ` +
                `rotateY(${rotateY.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
            tile.el.style.opacity = op.toFixed(3);
            tile.el.style.filter = `blur(${blur}px) grayscale(${gray})`;
            tile.el.style.zIndex = String(100 - Math.round(ad * 10));
            tile.el.classList.toggle('is-active', ad < 0.5);
        }
    }

    destroy() {
        this._stop();
        this._cancelAutoplay();
        this._handlers.forEach(([t, k, fn]) => t.removeEventListener(k, fn));
        if (this._sectionIO) this._sectionIO.disconnect();
        if (this.root) this.root.remove();
    }
}

let _carousel = null;

// ============================================================
// 渲染入口
// ============================================================
function renderHead(meta) {
    const eyebrow = document.getElementById('envEyebrow');
    const title = document.getElementById('envTitle');
    const desc = document.getElementById('envSubtitle');
    if (eyebrow && meta?.env_eyebrow)  eyebrow.textContent = meta.env_eyebrow;
    if (title   && meta?.env_title)    title.textContent   = meta.env_title;
    if (desc    && meta?.env_subtitle) desc.textContent    = meta.env_subtitle;
}

function renderGrid(items, meta) {
    const grid = document.getElementById('envGrid');
    if (!grid) return;

    if (_carousel) { try { _carousel.destroy(); } catch {} _carousel = null; }
    grid.innerHTML = '';
    grid.classList.add('env-mosaic--river');

    if (!items || !items.length) {
        grid.innerHTML = `
            <div class="env-empty">
                <i class="fas fa-images"></i>
                <p>暂未配置环境图片</p>
            </div>
        `;
        return;
    }

    _carousel = new StreamCarousel(grid, items, meta || {});
    _carousel.mount();
}

// ============================================================
// Lightbox（保留 + 滑动手势）
// ============================================================
let lightboxState = { index: 0, items: [] };

function ensureLightbox() {
    let el = document.getElementById('envLightbox');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'envLightbox';
    el.className = 'env-lightbox';
    el.innerHTML = `
        <button class="env-lightbox__close" aria-label="关闭"><i class="fas fa-times"></i></button>
        <button class="env-lightbox__nav env-lightbox__nav--prev" aria-label="上一张"><i class="fas fa-chevron-left"></i></button>
        <div class="env-lightbox__stage">
            <img class="env-lightbox__img" alt="" draggable="false" />
            <div class="env-lightbox__meta">
                <h4 class="env-lightbox__title"></h4>
                <p class="env-lightbox__desc"></p>
                <span class="env-lightbox__counter"></span>
            </div>
        </div>
        <button class="env-lightbox__nav env-lightbox__nav--next" aria-label="下一张"><i class="fas fa-chevron-right"></i></button>
    `;
    document.body.appendChild(el);

    el.querySelector('.env-lightbox__close').addEventListener('click', closeLightbox);
    el.addEventListener('click', (e) => { if (e.target === el) closeLightbox(); });
    el.querySelector('.env-lightbox__nav--prev').addEventListener('click', () => navLightbox(-1));
    el.querySelector('.env-lightbox__nav--next').addEventListener('click', () => navLightbox(1));
    document.addEventListener('keydown', (e) => {
        if (!el.classList.contains('open')) return;
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft') navLightbox(-1);
        else if (e.key === 'ArrowRight') navLightbox(1);
    });

    const stage = el.querySelector('.env-lightbox__stage');
    const img = el.querySelector('.env-lightbox__img');
    let sx = 0, dx = 0, drag = false;
    stage.addEventListener('pointerdown', (e) => {
        drag = true; sx = e.clientX; dx = 0;
        try { stage.setPointerCapture(e.pointerId); } catch {}
    });
    stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        dx = e.clientX - sx;
        img.style.transform = `translateX(${dx}px) scale(${1 - Math.min(0.05, Math.abs(dx) / 1500)})`;
    });
    const end = () => {
        if (!drag) return;
        drag = false;
        if (Math.abs(dx) > 60) navLightbox(dx < 0 ? 1 : -1);
        img.style.transition = 'transform .3s cubic-bezier(.2,.7,.2,1)';
        img.style.transform = '';
        setTimeout(() => { img.style.transition = ''; }, 320);
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    return el;
}

function openLightbox(items, index) {
    const el = ensureLightbox();
    lightboxState.items = items;
    lightboxState.index = index;
    paintLightbox();
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function paintLightbox() {
    const el = document.getElementById('envLightbox');
    if (!el) return;
    const items = lightboxState.items;
    const i = lightboxState.index;
    const it = items[i] || {};
    const imgEl = el.querySelector('.env-lightbox__img');
    imgEl.style.opacity = '0';
    setTimeout(() => {
        imgEl.src = it.image || '';
        imgEl.alt = it.alt || it.title || '';
        const showImg = () => { imgEl.style.opacity = '1'; };
        imgEl.onload = showImg;
        // 缓存命中时 onload 可能不再触发，做兜底
        if (imgEl.complete && imgEl.naturalWidth > 0) showImg();
        else setTimeout(showImg, 600); // 极端兜底
    }, 100);
    el.querySelector('.env-lightbox__title').textContent = it.title || '';
    el.querySelector('.env-lightbox__desc').textContent = it.description || '';
    el.querySelector('.env-lightbox__counter').textContent = `${i + 1} / ${items.length}`;
    el.querySelector('.env-lightbox__nav--prev').style.visibility = items.length > 1 ? 'visible' : 'hidden';
    el.querySelector('.env-lightbox__nav--next').style.visibility = items.length > 1 ? 'visible' : 'hidden';
}

function navLightbox(dir) {
    const len = lightboxState.items.length;
    if (!len) return;
    lightboxState.index = (lightboxState.index + dir + len) % len;
    paintLightbox();
    // 同步主轮播位置
    if (_carousel) _carousel._goto(lightboxState.index);
}

function closeLightbox() {
    const el = document.getElementById('envLightbox');
    if (!el) return;
    el.classList.remove('open');
    document.body.style.overflow = '';
}

// ============================================================
// 数据
// ============================================================
async function fetchAndRender() {
    try {
        const resp = await fetch(API_URL, { cache: 'no-store' });
        const json = await resp.json();
        if (!resp.ok || json.code !== 0) {
            renderGrid([], {});
            return;
        }
        const data = json.data || {};
        renderHead(data.meta || {});
        renderGrid(data.items || [], data.meta || {});
    } catch (err) {
        console.warn('环境数据加载失败：', err);
        renderGrid([], {});
    }
}

export function initEnvironment() {
    const grid = document.getElementById('envGrid');
    if (!grid) return;
    fetchAndRender();

    window.addEventListener('storage', (e) => {
        if (e.key === 'yx_environment_updated') fetchAndRender();
    });
    try {
        if ('BroadcastChannel' in window) {
            const bc = new BroadcastChannel('yx-environment-sync');
            bc.addEventListener('message', () => fetchAndRender());
        }
    } catch { /* ignore */ }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') fetchAndRender();
    });
}
