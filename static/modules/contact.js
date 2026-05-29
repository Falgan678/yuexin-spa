// 联系我们模块 - 从后端拉取配置并动态渲染
const ENDPOINT = '/api/contact-info';

export async function initContact() {
    const grid = document.getElementById('contactGrid');
    if (!grid) return;

    try {
        const resp = await fetch(ENDPOINT, { cache: 'no-store' });
        const result = await resp.json();
        if (result.code !== 0) throw new Error(result.detail || '加载失败');
        renderGrid(grid, result.data || []);
        // 同步底部"一键拨号"按钮的 tel 链接
        syncCallButton(result.data || []);
    } catch (e) {
        console.error('加载联系方式失败:', e);
        renderFallback(grid);
    }
}

function syncCallButton(items) {
    const phone = items.find(i => i.type === 'phone');
    const btn = document.getElementById('contactCallBtn');
    if (btn && phone && phone.value) {
        btn.href = `tel:${phone.value}`;
    }
}

function renderFallback(grid) {
    grid.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'contact-card animate-on-scroll in';
    div.style.gridColumn = '1 / -1';
    div.innerHTML = `
        <div class="ic"><i class="fas fa-circle-info"></i></div>
        <h3>暂时无法加载</h3>
        <p>请刷新页面或稍后重试</p>
    `;
    grid.appendChild(div);
}

function renderGrid(grid, items) {
    grid.innerHTML = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'contact-card animate-on-scroll in';
        empty.style.gridColumn = '1 / -1';
        empty.innerHTML = '<div class="ic"><i class="fas fa-info-circle"></i></div><h3>暂无联系方式</h3><p>请稍后再试</p>';
        grid.appendChild(empty);
        return;
    }

    items.forEach(item => {
        grid.appendChild(buildCard(item));
    });

    // 触发渐入动画
    requestAnimationFrame(() => {
        grid.querySelectorAll('.contact-card').forEach(el => el.classList.add('in'));
    });
}

function buildCard(item) {
    const card = document.createElement('div');
    card.className = 'contact-card animate-on-scroll';

    const ic = document.createElement('div');
    ic.className = 'ic';
    const i = document.createElement('i');
    // icon 字段支持 "fab fa-weixin" 或 "fa-phone-alt" 两种写法
    const iconClass = (item.icon || 'fa-circle-info').trim();
    i.className = iconClass.includes(' ') ? iconClass : `fas ${iconClass}`;
    ic.appendChild(i);
    card.appendChild(ic);

    const h3 = document.createElement('h3');
    h3.textContent = item.label || item.key;
    card.appendChild(h3);

    // 内容部分：根据 type 决定渲染方式
    const content = buildContent(item);
    card.appendChild(content);

    return card;
}

function buildContent(item) {
    const { value = '', type = 'text', label = '' } = item;
    if (!value) {
        const p = document.createElement('p');
        p.className = 'contact-empty';
        p.textContent = '尚未配置';
        return p;
    }

    if (type === 'phone') {
        const a = document.createElement('a');
        a.href = `tel:${value}`;
        a.className = 'contact-link contact-value';
        a.dataset.copy = value;
        a.title = `点击复制${label}`;
        a.textContent = value;
        return a;
    }
    if (type === 'wechat') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'contact-link contact-value wechat-id';
        btn.dataset.copy = value;
        btn.title = '点击复制微信号';
        btn.textContent = value;
        return btn;
    }
    if (type === 'email') {
        const a = document.createElement('a');
        a.href = `mailto:${value}`;
        a.className = 'contact-link contact-value';
        a.dataset.copy = value;
        a.title = '点击复制邮箱';
        a.textContent = value;
        return a;
    }
    if (type === 'url') {
        const a = document.createElement('a');
        a.href = value;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'contact-link contact-value is-url';
        a.title = value; // 悬停展示完整链接
        // 显示时去掉协议头与末尾斜杠，避免长 URL 在窄卡片里被中段截断为奇怪的单词
        a.textContent = value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
        return a;
    }
    // text - 营业时间一般不需要复制
    if (item.key === 'contact_hours') {
        const p = document.createElement('p');
        p.className = 'contact-value';
        p.textContent = value;
        return p;
    }
    // 其他 text（地址等）：可点击复制
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'contact-link contact-value';
    btn.dataset.copy = value;
    btn.title = `点击复制${label}`;
    btn.textContent = value;
    return btn;
}
