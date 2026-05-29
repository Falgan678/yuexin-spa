/**
 * 后台内置审计面板（不再使用独立 audit.html）
 * ============================================================
 * - 由 admin.html 顶栏按钮 #auditBtn 触发
 * - 复用全局 http.js / toast.js
 * - 复用现有 admin.html 的 .hidden 显示策略与 Tailwind 样式
 *
 * 渲染容器：#auditPanel（在 admin.html 中预先放置）
 * 内部 ID：
 *   auditPanel-mask
 *   auditPanel-close
 *   auditPanel-actor / -resource / -action / -rid / -start / -end
 *   auditPanel-search / -reset / -export
 *   auditPanel-tbody / -stats / -info / -prev / -next
 */

import { http, BizError } from './http.js';
import { toast } from './toast.js';

const PAGE_SIZE = 50;

const ACTION_TAG = {
    create:        'bg-emerald-100 text-emerald-700',
    update:        'bg-blue-100 text-blue-700',
    status_update: 'bg-blue-100 text-blue-700',
    note_update:   'bg-blue-100 text-blue-700',
    delete:        'bg-rose-100 text-rose-700',
    login:         'bg-violet-100 text-violet-700',
    login_failed:  'bg-amber-100 text-amber-700',
};

let currentOffset = 0;
let currentTotal = 0;
let bound = false;

function $(id) { return document.getElementById(id); }
function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildQuery() {
    const params = new URLSearchParams();
    const actor = $('auditPanel-actor').value.trim();
    const resource = $('auditPanel-resource').value;
    const action = $('auditPanel-action').value;
    const rid = $('auditPanel-rid').value.trim();
    const start = $('auditPanel-start').value;
    const end = $('auditPanel-end').value;

    if (actor) params.set('actor', actor);
    if (resource) params.set('resource', resource);
    if (action) params.set('action', action);
    if (rid) params.set('resource_id', rid);
    if (start) params.set('start', start.replace('T', ' ') + ':00');
    if (end)   params.set('end',   end.replace('T', ' ') + ':59');
    params.set('limit', PAGE_SIZE);
    params.set('offset', currentOffset);
    return params.toString();
}

function renderRow(row) {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-50 border-b border-gray-100';
    const action = row.action || '';
    const tagCls = ACTION_TAG[action] || 'bg-gray-100 text-gray-700';

    let diffCell = '<span class="text-gray-400">—</span>';
    if (row.diff) {
        const text = JSON.stringify(row.diff, null, 2);
        const diffId = `auditPanel-diff-${row.id}`;
        diffCell = `
            <button class="audit-diff-toggle text-indigo-600 text-xs hover:underline"
                    data-target="${diffId}">查看 ▾</button>
            <pre id="${diffId}" class="audit-diff-pre hidden mt-1 p-2 bg-gray-900 text-gray-100 text-[11px] rounded max-h-60 overflow-auto whitespace-pre-wrap break-all">${escHtml(text)}</pre>`;
    }

    tr.innerHTML = `
        <td class="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">${escHtml(row.created_at)}</td>
        <td class="px-3 py-2 text-sm font-medium text-gray-700">${escHtml(row.actor)}</td>
        <td class="px-3 py-2"><span class="inline-block px-2 py-0.5 rounded-full text-xs ${tagCls}">${escHtml(action)}</span></td>
        <td class="px-3 py-2"><span class="inline-block px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700">${escHtml(row.resource || '')}${row.resource_id ? ' #' + escHtml(row.resource_id) : ''}</span></td>
        <td class="px-3 py-2 text-sm text-gray-700">${escHtml(row.summary || '')}</td>
        <td class="px-3 py-2 text-sm">${diffCell}</td>
        <td class="px-3 py-2 text-xs text-gray-500"><code>${escHtml(row.ip || '')}</code></td>
    `;
    return tr;
}

async function loadData() {
    const tbody = $('auditPanel-tbody');
    const stats = $('auditPanel-stats');
    const info  = $('auditPanel-info');

    tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-10 text-center text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>加载中…</td></tr>`;

    try {
        const result = await http.get(`/api/admin/audit-logs?${buildQuery()}`,
                                      { auth: true, silent: true });
        const data = result?.data || { items: [], total: 0 };
        currentTotal = data.total || 0;

        if (!data.items.length) {
            tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-10 text-center text-gray-400">
                <i class="fas fa-inbox text-3xl mb-2 block text-gray-300"></i>
                暂无符合条件的审计记录
            </td></tr>`;
        } else {
            tbody.innerHTML = '';
            data.items.forEach(r => tbody.appendChild(renderRow(r)));
        }

        stats.innerHTML = `共 <strong class="text-indigo-600">${currentTotal}</strong> 条 · 显示 ${data.items.length ? currentOffset + 1 : 0} - ${Math.min(currentOffset + PAGE_SIZE, currentTotal)}`;
        info.textContent = `第 ${Math.floor(currentOffset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(currentTotal / PAGE_SIZE))} 页`;
        $('auditPanel-prev').disabled = currentOffset <= 0;
        $('auditPanel-next').disabled = currentOffset + PAGE_SIZE >= currentTotal;
    } catch (err) {
        const msg = (err instanceof BizError) ? err.message : '加载失败';
        tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-10 text-center text-rose-500">
            <i class="fas fa-triangle-exclamation mr-2"></i>${escHtml(msg)}
        </td></tr>`;
        if (err instanceof BizError && err.status === 401) {
            toast.warning('登录已过期，请重新登录');
        } else {
            toast.error(msg);
        }
    }
}

function openPanel() {
    const root = $('auditPanel');
    if (!root) return;
    // 必须已登录才有意义；未登录时让 admin.js 的登录流程优先
    const tokenExists = !!(localStorage.getItem('yx_admin_token')
                        || localStorage.getItem('admin_token'));
    if (!tokenExists) {
        toast.warning('请先登录管理后台');
        return;
    }
    root.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // 打开后清除 #audit hash，避免 F5/复制链接后被反复触发
    if (location.hash === '#audit') {
        try {
            history.replaceState(null, '', location.pathname + location.search);
        } catch { /* ignore */ }
    }
    currentOffset = 0;
    loadData();
}

function closePanel() {
    const root = $('auditPanel');
    if (!root) return;
    root.classList.add('hidden');
    document.body.style.overflow = '';
}

async function exportCsv() {
    const params = new URLSearchParams();
    const actor = $('auditPanel-actor').value.trim();
    const resource = $('auditPanel-resource').value;
    const action = $('auditPanel-action').value;
    const rid = $('auditPanel-rid').value.trim();
    const start = $('auditPanel-start').value;
    const end = $('auditPanel-end').value;
    if (actor) params.set('actor', actor);
    if (resource) params.set('resource', resource);
    if (action) params.set('action', action);
    if (rid) params.set('resource_id', rid);
    if (start) params.set('start', start.replace('T', ' ') + ':00');
    if (end)   params.set('end',   end.replace('T', ' ') + ':59');

    const tk = localStorage.getItem('yx_admin_token')
            || localStorage.getItem('admin_token') || '';
    const url = `/api/admin/audit-logs/export.csv?${params.toString()}`;

    const tip = toast.loading('正在导出…');
    try {
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${tk}` } });
        if (resp.status === 401) {
            tip.dismiss();
            toast.error('登录已过期，请重新登录');
            return;
        }
        if (resp.status === 429) {
            tip.dismiss();
            toast.error('导出过于频繁，请稍后再试');
            return;
        }
        if (!resp.ok) {
            tip.dismiss();
            const t = await resp.text().catch(() => '');
            toast.error(`导出失败：${t || resp.status}`);
            return;
        }
        const cnt = resp.headers.get('X-Audit-Export-Count') || '?';
        const blob = await resp.blob();
        const a = document.createElement('a');
        const objUrl = URL.createObjectURL(blob);
        const cd = resp.headers.get('content-disposition') || '';
        const m = cd.match(/filename="?([^";]+)"?/i);
        a.href = objUrl;
        a.download = (m && m[1]) || `audit_logs_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
        tip.dismiss();
        toast.success(`已导出 ${cnt} 条审计记录`);
    } catch (err) {
        tip.dismiss();
        toast.error('导出失败：' + (err?.message || '网络异常'));
    }
}

function bindOnce() {
    if (bound) return;
    bound = true;

    const btn = $('auditBtn');
    if (btn) btn.addEventListener('click', openPanel);

    const close = $('auditPanel-close');
    if (close) close.addEventListener('click', closePanel);

    const mask = $('auditPanel-mask');
    if (mask) mask.addEventListener('click', closePanel);

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const root = $('auditPanel');
            if (root && !root.classList.contains('hidden')) closePanel();
        }
    });

    const search = $('auditPanel-search');
    if (search) search.addEventListener('click', () => { currentOffset = 0; loadData(); });

    const reset = $('auditPanel-reset');
    if (reset) reset.addEventListener('click', () => {
        ['auditPanel-actor', 'auditPanel-rid', 'auditPanel-start', 'auditPanel-end']
            .forEach(id => { const el = $(id); if (el) el.value = ''; });
        const r = $('auditPanel-resource'); if (r) r.value = '';
        const a = $('auditPanel-action');   if (a) a.value = '';
        currentOffset = 0;
        loadData();
    });

    const exp = $('auditPanel-export');
    if (exp) exp.addEventListener('click', exportCsv);

    const prev = $('auditPanel-prev');
    if (prev) prev.addEventListener('click', () => {
        if (currentOffset >= PAGE_SIZE) { currentOffset -= PAGE_SIZE; loadData(); }
    });
    const next = $('auditPanel-next');
    if (next) next.addEventListener('click', () => {
        if (currentOffset + PAGE_SIZE < currentTotal) { currentOffset += PAGE_SIZE; loadData(); }
    });

    // 委托：展开/折叠 diff
    document.addEventListener('click', e => {
        const btn = e.target.closest('.audit-diff-toggle');
        if (!btn) return;
        const target = document.getElementById(btn.dataset.target);
        if (!target) return;
        target.classList.toggle('hidden');
        btn.textContent = target.classList.contains('hidden') ? '查看 ▾' : '收起 ▴';
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuditPanel);
} else {
    initAuditPanel();
}

function tryOpenAfterLogin(maxWaitMs = 8000) {
    const startedAt = Date.now();
    const tick = () => {
        const app = document.getElementById('adminApp');
        const tokenExists = !!(localStorage.getItem('yx_admin_token')
                            || localStorage.getItem('admin_token'));
        // adminApp 已显示且 token 已写入 → 才打开
        if (app && !app.classList.contains('hidden') && tokenExists) {
            openPanel();
            return;
        }
        if (Date.now() - startedAt > maxWaitMs) return; // 放弃
        setTimeout(tick, 200);
    };
    tick();
}

function initAuditPanel() {
    bindOnce();
    // 兼容老入口：admin.html#audit → 等登录完成后自动展开
    if (location.hash === '#audit') {
        setTimeout(() => tryOpenAfterLogin(8000), 200);
    }
    // 同一页面下 hash 改成 #audit 也响应（用于内部链接）
    window.addEventListener('hashchange', () => {
        if (location.hash === '#audit') tryOpenAfterLogin(2000);
    });
}
