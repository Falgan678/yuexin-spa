/**
 * 人员权限管理 + 修改密码 模块
 * - 完全独立的 ES module，可在 admin.html 中通过 <script type="module"> 直接引入
 * - 依赖：localStorage 中的 token（key: yx_admin_token，与 admin.js 一致）
 * - 设计：自动等待 DOMContentLoaded → 拉取 /api/admin/me 判断当前用户角色 →
 *         按权限显隐"权限"按钮 → 绑定弹窗事件
 */

const TOKEN_KEY = 'yx_admin_token';

// ----------------- 通用 fetch -----------------
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

async function api(url, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(url, { ...options, headers });
    let body = null;
    try { body = await resp.json(); } catch (_) { body = null; }
    if (!resp.ok) {
        const msg = (body && (body.detail || body.message)) || `HTTP ${resp.status}`;
        const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        e.status = resp.status;
        throw e;
    }
    return body;
}

// 简单提示：复用全局 showNotification（admin.js 暴露在 window 上不一定，这里兜底）
function notify(msg, type = 'info') {
    if (typeof window.showNotification === 'function') {
        window.showNotification(msg, type);
        return;
    }
    // 简易兜底
    const div = document.createElement('div');
    const colors = {
        success: 'bg-emerald-600', error: 'bg-rose-600',
        warning: 'bg-amber-600', info: 'bg-blue-600',
    };
    div.className = `fixed top-20 right-6 z-[80] px-4 py-3 rounded-lg shadow-lg text-white ${colors[type] || colors.info}`;
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 2400);
}

function setError(elId, msg) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (msg) {
        el.textContent = msg;
        el.classList.remove('hidden');
    } else {
        el.textContent = '';
        el.classList.add('hidden');
    }
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ----------------- 状态 -----------------
const state = {
    currentUser: null,   // {username, role_key, permissions, is_builtin, ...}
    meta: null,          // {modules:[], actions:[], builtin_roles:[]}
    roles: [],
    users: [],
};

function hasPerm(p) {
    if (!state.currentUser) return false;
    if (state.currentUser.role_key === 'super_admin') return true;
    return (state.currentUser.permissions || []).includes(p);
}

// ----------------- 密码强度校验（与后端规则一致） -----------------
function validatePwd(pwd) {
    if (!pwd || pwd.length < 8) return '密码长度至少 8 位';
    if (pwd.length > 100) return '密码长度不能超过 100 位';
    const hasLetter = /[A-Za-z]/.test(pwd);
    const hasDigit = /\d/.test(pwd);
    const hasSymbol = /[^A-Za-z0-9]/.test(pwd);
    if ([hasLetter, hasDigit, hasSymbol].filter(Boolean).length < 2) {
        return '密码须至少包含字母、数字、符号中的两类';
    }
    return null;
}

function pwdStrengthLabel(pwd) {
    let score = 0;
    if (!pwd) return null;
    if (pwd.length >= 8) score++;
    if (pwd.length >= 12) score++;
    if (/[A-Za-z]/.test(pwd)) score++;
    if (/\d/.test(pwd)) score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;
    if (score <= 2) return { text: '弱', cls: 'text-rose-600' };
    if (score === 3) return { text: '中', cls: 'text-amber-600' };
    return { text: '强', cls: 'text-emerald-600' };
}

// ============================================================
// 修改密码
// ============================================================
function openChangePwd() {
    document.getElementById('cpOld').value = '';
    document.getElementById('cpNew').value = '';
    document.getElementById('cpConfirm').value = '';
    setError('cpError', '');
    document.getElementById('cpStrength').classList.add('hidden');
    document.getElementById('cpMismatch').classList.add('hidden');
    const m = document.getElementById('changePwdModal');
    m.classList.remove('hidden');
    m.classList.add('flex');
    setTimeout(() => document.getElementById('cpOld').focus(), 60);
}

function closeChangePwd() {
    const m = document.getElementById('changePwdModal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

async function submitChangePwd(ev) {
    ev.preventDefault();
    setError('cpError', '');
    const oldP = document.getElementById('cpOld').value;
    const newP = document.getElementById('cpNew').value;
    const cfm = document.getElementById('cpConfirm').value;
    if (!oldP) { setError('cpError', '请输入原密码'); return; }
    const err = validatePwd(newP);
    if (err) { setError('cpError', err); return; }
    if (newP !== cfm) { setError('cpError', '两次输入的新密码不一致'); return; }
    if (oldP === newP) { setError('cpError', '新密码不能与原密码相同'); return; }

    const btn = document.getElementById('cpSubmit');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>提交中…';
    try {
        await api('/api/admin/change-password', {
            method: 'POST',
            body: JSON.stringify({
                old_password: oldP, new_password: newP, confirm_password: cfm,
            }),
        });
        notify('密码已更新，请妥善保管', 'success');
        closeChangePwd();
    } catch (e) {
        setError('cpError', e.message || '修改失败');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check mr-1"></i>确认修改';
    }
}

function bindChangePwdEvents() {
    document.getElementById('changePwdBtn')?.addEventListener('click', openChangePwd);
    document.getElementById('closeChangePwdBtn')?.addEventListener('click', closeChangePwd);
    document.getElementById('cpCancel')?.addEventListener('click', closeChangePwd);
    document.getElementById('changePwdForm')?.addEventListener('submit', submitChangePwd);
    document.getElementById('changePwdModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'changePwdModal') closeChangePwd();
    });
    document.getElementById('cpNew')?.addEventListener('input', (e) => {
        const lbl = pwdStrengthLabel(e.target.value);
        const el = document.getElementById('cpStrength');
        if (!lbl) { el.classList.add('hidden'); return; }
        el.className = `text-xs mt-1 ${lbl.cls}`;
        el.textContent = '强度：' + lbl.text;
        el.classList.remove('hidden');
    });
    document.getElementById('cpConfirm')?.addEventListener('input', (e) => {
        const newP = document.getElementById('cpNew').value;
        const tip = document.getElementById('cpMismatch');
        if (e.target.value && e.target.value !== newP) tip.classList.remove('hidden');
        else tip.classList.add('hidden');
    });
}

// ============================================================
// 人员权限管理
// ============================================================
function openUserMgmt() {
    if (!hasPerm('user:manage')) {
        notify('您无权管理人员/角色', 'warning');
        return;
    }
    const m = document.getElementById('userMgmtModal');
    m.classList.remove('hidden');
    m.classList.add('flex');
    switchTab('users');
    Promise.all([loadRoles(), loadUsers(), loadMeta()]).catch(() => {});
}

function closeUserMgmt() {
    const m = document.getElementById('userMgmtModal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

function switchTab(tab) {
    document.querySelectorAll('.um-tab').forEach((b) => {
        const active = b.dataset.umTab === tab;
        b.classList.toggle('border-purple-600', active);
        b.classList.toggle('text-purple-600', active);
        b.classList.toggle('font-medium', active);
        b.classList.toggle('border-transparent', !active);
        b.classList.toggle('text-gray-500', !active);
    });
    document.getElementById('umTabUsers').classList.toggle('hidden', tab !== 'users');
    document.getElementById('umTabRoles').classList.toggle('hidden', tab !== 'roles');
}

async function loadMeta() {
    if (state.meta) return state.meta;
    try {
        const r = await api('/api/admin/auth/meta');
        state.meta = r.data;
    } catch (e) {
        notify('加载权限元数据失败：' + e.message, 'error');
    }
    return state.meta;
}

async function loadRoles() {
    try {
        const r = await api('/api/admin/roles');
        state.roles = r.data || [];
        renderRoles();
    } catch (e) {
        notify('加载角色失败：' + e.message, 'error');
    }
}

async function loadUsers() {
    try {
        const r = await api('/api/admin/users');
        state.users = r.data || [];
        renderUsers();
    } catch (e) {
        notify('加载用户失败：' + e.message, 'error');
    }
}

function renderUsers() {
    const tbody = document.getElementById('umUsersBody');
    const empty = document.getElementById('umUsersEmpty');
    tbody.innerHTML = '';
    if (!state.users.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    state.users.forEach((u) => {
        const role = state.roles.find((r) => r.role_key === u.role_key);
        const roleName = role ? role.name : u.role_key;
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gray-50';
        tr.innerHTML = `
            <td class="px-4 py-2 text-sm text-gray-800">
                <i class="fas ${u.is_builtin ? 'fa-user-shield text-emerald-600' : 'fa-user text-gray-500'} mr-1"></i>
                ${escapeHtml(u.username)}
                ${u.is_builtin ? '<span class="ml-1 text-xs px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">内置</span>' : ''}
            </td>
            <td class="px-4 py-2 text-sm text-gray-600">${escapeHtml(u.display_name) || '-'}</td>
            <td class="px-4 py-2 text-sm">
                <span class="px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-xs">${escapeHtml(roleName)}</span>
            </td>
            <td class="px-4 py-2 text-sm">
                ${u.is_active
                    ? '<span class="text-emerald-600"><i class="fas fa-circle-check mr-1"></i>启用</span>'
                    : '<span class="text-rose-600"><i class="fas fa-circle-xmark mr-1"></i>已禁用</span>'}
            </td>
            <td class="px-4 py-2 text-xs text-gray-500">${escapeHtml(u.last_login_at || '-')}</td>
            <td class="px-4 py-2 text-right text-sm space-x-2">
                <button class="text-blue-600 hover:underline um-edit-user" data-username="${escapeHtml(u.username)}">编辑</button>
                ${u.is_builtin
                    ? '<span class="text-gray-400">删除</span>'
                    : `<button class="text-rose-600 hover:underline um-del-user" data-username="${escapeHtml(u.username)}">删除</button>`
                }
            </td>
        `;
        tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.um-edit-user').forEach((b) => {
        b.addEventListener('click', () => {
            const u = state.users.find((x) => x.username === b.dataset.username);
            if (u) openUserModal(u);
        });
    });
    tbody.querySelectorAll('.um-del-user').forEach((b) => {
        b.addEventListener('click', () => deleteUser(b.dataset.username));
    });
}

function renderRoles() {
    const grid = document.getElementById('umRolesBody');
    const empty = document.getElementById('umRolesEmpty');
    grid.innerHTML = '';
    if (!state.roles.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    state.roles.forEach((r) => {
        const card = document.createElement('div');
        card.className = 'border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow';
        const permCount = (r.permissions || []).length;
        card.innerHTML = `
            <div class="flex justify-between items-start mb-2">
                <div>
                    <h4 class="font-bold text-gray-800">
                        ${escapeHtml(r.name)}
                        ${r.builtin ? '<span class="ml-1 text-xs px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">内置</span>' : ''}
                    </h4>
                    <p class="text-xs text-gray-500 mt-0.5">${escapeHtml(r.role_key)} · 级别 ${r.level} · ${permCount} 项权限</p>
                </div>
                <div class="space-x-2 text-sm">
                    <button class="text-blue-600 hover:underline um-edit-role" data-key="${escapeHtml(r.role_key)}">编辑</button>
                    ${(r.builtin || r.role_key === 'super_admin')
                        ? '<span class="text-gray-400">删除</span>'
                        : `<button class="text-rose-600 hover:underline um-del-role" data-key="${escapeHtml(r.role_key)}">删除</button>`
                    }
                </div>
            </div>
            <p class="text-sm text-gray-600 mb-2">${escapeHtml(r.description || '（无描述）')}</p>
            <div class="text-xs text-gray-500 max-h-20 overflow-y-auto">
                ${(r.permissions || []).map((p) => `<span class="inline-block px-1.5 py-0.5 mr-1 mb-1 bg-gray-100 rounded">${escapeHtml(p)}</span>`).join('')}
            </div>
        `;
        grid.appendChild(card);
    });
    grid.querySelectorAll('.um-edit-role').forEach((b) => {
        b.addEventListener('click', () => {
            const r = state.roles.find((x) => x.role_key === b.dataset.key);
            if (r) openRoleModal(r);
        });
    });
    grid.querySelectorAll('.um-del-role').forEach((b) => {
        b.addEventListener('click', () => deleteRole(b.dataset.key));
    });
}

// ----------------- 用户编辑 -----------------
function openUserModal(user) {
    const isEdit = !!user;
    document.getElementById('umUserModalTitle').textContent = isEdit ? '编辑账号' : '新增账号';
    document.getElementById('umUserOriginal').value = isEdit ? user.username : '';
    const usernameInput = document.getElementById('umUserUsername');
    usernameInput.value = isEdit ? user.username : '';
    usernameInput.disabled = isEdit;
    document.getElementById('umUserDisplay').value = isEdit ? (user.display_name || '') : '';

    // 角色下拉
    const roleSelect = document.getElementById('umUserRole');
    roleSelect.innerHTML = '';
    state.roles.forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.role_key;
        opt.textContent = `${r.name}（${r.role_key} · L${r.level}）`;
        roleSelect.appendChild(opt);
    });
    roleSelect.value = isEdit ? user.role_key : 'viewer';

    // 内置 super_admin 用户：不允许改角色
    roleSelect.disabled = !!(isEdit && user.is_builtin);

    document.getElementById('umUserActive').checked = isEdit ? !!user.is_active : true;
    document.getElementById('umUserActive').disabled = !!(isEdit && user.is_builtin); // 内置不可禁用
    document.getElementById('umUserPassword').value = '';
    document.getElementById('umUserPwdRequired').classList.toggle('hidden', isEdit);
    document.getElementById('umUserPwdHint').textContent = isEdit
        ? '留空表示不修改；如需重置密码请填写。'
        : '长度 ≥ 8 位，须至少包含字母、数字、符号中的两类。';

    setError('umUserError', '');
    const m = document.getElementById('umUserModal');
    m.classList.remove('hidden');
    m.classList.add('flex');
    setTimeout(() => (isEdit ? document.getElementById('umUserDisplay') : usernameInput).focus(), 60);
}

function closeUserModal() {
    const m = document.getElementById('umUserModal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

async function submitUserForm(ev) {
    ev.preventDefault();
    setError('umUserError', '');
    const original = document.getElementById('umUserOriginal').value;
    const isEdit = !!original;

    const username = document.getElementById('umUserUsername').value.trim();
    const display = document.getElementById('umUserDisplay').value.trim();
    const role = document.getElementById('umUserRole').value;
    const active = document.getElementById('umUserActive').checked;
    const pwd = document.getElementById('umUserPassword').value;

    if (!isEdit) {
        if (!/^[A-Za-z0-9_\-\.]{3,32}$/.test(username)) {
            setError('umUserError', '用户名格式无效（字母/数字/_-./，3-32 位）'); return;
        }
        const err = validatePwd(pwd);
        if (err) { setError('umUserError', err); return; }
    } else if (pwd) {
        const err = validatePwd(pwd);
        if (err) { setError('umUserError', err); return; }
    }
    if (!role) { setError('umUserError', '请选择角色'); return; }

    try {
        if (isEdit) {
            const body = { display_name: display, role_key: role, is_active: active };
            if (pwd) body.new_password = pwd;
            await api(`/api/admin/users/${encodeURIComponent(original)}`, {
                method: 'PUT', body: JSON.stringify(body),
            });
            notify('账号已更新', 'success');
        } else {
            await api('/api/admin/users', {
                method: 'POST',
                body: JSON.stringify({
                    username, password: pwd, role_key: role,
                    display_name: display, is_active: active,
                }),
            });
            notify('账号已创建', 'success');
        }
        closeUserModal();
        await loadUsers();
    } catch (e) {
        setError('umUserError', e.message || '保存失败');
    }
}

async function deleteUser(username) {
    if (!confirm(`确认删除账号 "${username}"？该操作不可撤销。`)) return;
    try {
        await api(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        notify('账号已删除', 'success');
        await loadUsers();
    } catch (e) {
        notify('删除失败：' + e.message, 'error');
    }
}

// ----------------- 角色编辑 -----------------
function openRoleModal(role) {
    if (!state.meta) { notify('元数据未就绪', 'warning'); return; }
    const isEdit = !!role;
    const isSuper = isEdit && role.role_key === 'super_admin';
    document.getElementById('umRoleModalTitle').textContent = isEdit ? '编辑角色' : '新增角色';
    document.getElementById('umRoleOriginalKey').value = isEdit ? role.role_key : '';
    document.getElementById('umRoleBuiltin').value = isEdit && role.builtin ? '1' : '0';
    const keyInput = document.getElementById('umRoleKey');
    keyInput.value = isEdit ? role.role_key : '';
    keyInput.disabled = isEdit;
    document.getElementById('umRoleName').value = isEdit ? role.name : '';
    document.getElementById('umRoleLevel').value = isEdit ? role.level : 10;
    document.getElementById('umRoleLevel').disabled = isSuper;
    document.getElementById('umRoleDesc').value = isEdit ? (role.description || '') : '';
    setError('umRoleError', '');

    // 渲染权限矩阵
    renderPermGrid(role ? role.permissions : []);
    // super_admin：禁用所有权限勾选
    if (isSuper) {
        document.querySelectorAll('#umRolePermGrid input[type=checkbox]').forEach((cb) => {
            cb.disabled = true;
            cb.checked = true;
        });
    }

    const m = document.getElementById('umRoleModal');
    m.classList.remove('hidden');
    m.classList.add('flex');
    setTimeout(() => (isEdit ? document.getElementById('umRoleName') : keyInput).focus(), 60);
}

function closeRoleModal() {
    const m = document.getElementById('umRoleModal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

function renderPermGrid(currentPerms) {
    const grid = document.getElementById('umRolePermGrid');
    const cur = new Set(currentPerms || []);
    const { modules, actions } = state.meta;
    const head = `
        <div class="grid grid-cols-[160px_1fr] bg-gray-50 border-b border-gray-200 sticky top-0 text-xs font-medium text-gray-600">
            <div class="px-3 py-2 border-r border-gray-200">模块</div>
            <div class="grid" style="grid-template-columns: repeat(${actions.length}, minmax(0,1fr));">
                ${actions.map((a) => `<div class="px-3 py-2 text-center">${escapeHtml(a.name)}</div>`).join('')}
            </div>
        </div>
    `;
    const rows = modules.map((m) => `
        <div class="grid grid-cols-[160px_1fr] border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
            <div class="px-3 py-2 text-sm text-gray-700 border-r border-gray-100">${escapeHtml(m.name)}<span class="text-xs text-gray-400 ml-1">${escapeHtml(m.id)}</span></div>
            <div class="grid" style="grid-template-columns: repeat(${actions.length}, minmax(0,1fr));">
                ${actions.map((a) => {
                    const key = `${m.id}:${a.id}`;
                    const checked = cur.has(key) ? 'checked' : '';
                    return `<label class="flex items-center justify-center py-2 cursor-pointer"><input type="checkbox" class="rounded text-purple-600" data-perm="${key}" ${checked} /></label>`;
                }).join('')}
            </div>
        </div>
    `).join('');
    grid.innerHTML = head + rows;
}

function readPermsFromGrid() {
    const out = [];
    document.querySelectorAll('#umRolePermGrid input[type=checkbox]').forEach((cb) => {
        if (cb.checked) out.push(cb.dataset.perm);
    });
    return out;
}

async function submitRoleForm(ev) {
    ev.preventDefault();
    setError('umRoleError', '');
    const original = document.getElementById('umRoleOriginalKey').value;
    const isEdit = !!original;
    const isSuper = original === 'super_admin';

    const key = document.getElementById('umRoleKey').value.trim();
    const name = document.getElementById('umRoleName').value.trim();
    const level = parseInt(document.getElementById('umRoleLevel').value, 10);
    const desc = document.getElementById('umRoleDesc').value.trim();
    const perms = readPermsFromGrid();

    if (!isEdit) {
        if (!/^[a-z][a-z0-9_]{1,30}$/.test(key)) {
            setError('umRoleError', '角色 key 格式无效（小写字母开头，2-31 位）'); return;
        }
    }
    if (!name) { setError('umRoleError', '请填写角色名称'); return; }
    if (!isSuper && (!Number.isFinite(level) || level < 1 || level > 99)) {
        setError('umRoleError', '权限级别须在 1~99 之间'); return;
    }

    try {
        if (isEdit) {
            const body = { name, description: desc };
            if (!isSuper) {
                body.level = level;
                body.permissions = perms;
            }
            await api(`/api/admin/roles/${encodeURIComponent(original)}`, {
                method: 'PUT', body: JSON.stringify(body),
            });
            notify('角色已更新', 'success');
        } else {
            await api('/api/admin/roles', {
                method: 'POST',
                body: JSON.stringify({
                    role_key: key, name, level, permissions: perms, description: desc,
                }),
            });
            notify('角色已创建', 'success');
        }
        closeRoleModal();
        await Promise.all([loadRoles(), loadUsers()]);
    } catch (e) {
        setError('umRoleError', e.message || '保存失败');
    }
}

async function deleteRole(roleKey) {
    if (!confirm(`确认删除角色 "${roleKey}"？该操作不可撤销。`)) return;
    try {
        await api(`/api/admin/roles/${encodeURIComponent(roleKey)}`, { method: 'DELETE' });
        notify('角色已删除', 'success');
        await loadRoles();
    } catch (e) {
        notify('删除失败：' + e.message, 'error');
    }
}

// ----------------- 事件绑定 -----------------
function bindUserMgmtEvents() {
    document.getElementById('userMgmtBtn')?.addEventListener('click', openUserMgmt);
    document.getElementById('closeUserMgmtBtn')?.addEventListener('click', closeUserMgmt);
    document.getElementById('userMgmtModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'userMgmtModal') closeUserMgmt();
    });
    document.querySelectorAll('.um-tab').forEach((b) => {
        b.addEventListener('click', () => switchTab(b.dataset.umTab));
    });

    document.getElementById('umRefreshUsers')?.addEventListener('click', loadUsers);
    document.getElementById('umRefreshRoles')?.addEventListener('click', loadRoles);
    document.getElementById('umAddUser')?.addEventListener('click', () => openUserModal(null));
    document.getElementById('umAddRole')?.addEventListener('click', () => openRoleModal(null));

    // 用户子弹窗
    document.getElementById('umUserClose')?.addEventListener('click', closeUserModal);
    document.getElementById('umUserCancel')?.addEventListener('click', closeUserModal);
    document.getElementById('umUserForm')?.addEventListener('submit', submitUserForm);
    document.getElementById('umUserModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'umUserModal') closeUserModal();
    });

    // 角色子弹窗
    document.getElementById('umRoleClose')?.addEventListener('click', closeRoleModal);
    document.getElementById('umRoleCancel')?.addEventListener('click', closeRoleModal);
    document.getElementById('umRoleForm')?.addEventListener('submit', submitRoleForm);
    document.getElementById('umRoleModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'umRoleModal') closeRoleModal();
    });
    document.getElementById('umRolePermAll')?.addEventListener('click', () => {
        document.querySelectorAll('#umRolePermGrid input[type=checkbox]').forEach((cb) => {
            if (!cb.disabled) cb.checked = true;
        });
    });
    document.getElementById('umRolePermNone')?.addEventListener('click', () => {
        document.querySelectorAll('#umRolePermGrid input[type=checkbox]').forEach((cb) => {
            if (!cb.disabled) cb.checked = false;
        });
    });
    document.getElementById('umRolePermReadOnly')?.addEventListener('click', () => {
        document.querySelectorAll('#umRolePermGrid input[type=checkbox]').forEach((cb) => {
            if (cb.disabled) return;
            cb.checked = (cb.dataset.perm || '').endsWith(':read');
        });
    });

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        ['umRoleModal', 'umUserModal', 'userMgmtModal', 'changePwdModal'].forEach((id) => {
            const el = document.getElementById(id);
            if (el && !el.classList.contains('hidden')) {
                if (id === 'changePwdModal') closeChangePwd();
                else if (id === 'userMgmtModal') closeUserMgmt();
                else if (id === 'umUserModal') closeUserModal();
                else if (id === 'umRoleModal') closeRoleModal();
            }
        });
    });
}

// ----------------- 启动 -----------------
async function bootstrap() {
    bindChangePwdEvents();
    bindUserMgmtEvents();

    // 初次加载时如果尚未登录，按钮先隐藏；登录后通过 refreshAccess 显隐
    const btn = document.getElementById('userMgmtBtn');
    btn?.classList.add('hidden');

    // 首次刷新一次（如果已登录会拉到 me）
    await refreshAccess();
    // 给主脚本一个钩子：登录成功/退出后调用，可以重新评估按钮可见性
    window.refreshUserMgmtAccess = refreshAccess;
}

async function refreshAccess() {
    const token = getToken();
    const btn = document.getElementById('userMgmtBtn');
    if (!token) {
        state.currentUser = null;
        btn?.classList.add('hidden');
        return;
    }
    try {
        const r = await api('/api/admin/me');
        state.currentUser = r.data || null;
        const can = (state.currentUser && (
            state.currentUser.role_key === 'super_admin' ||
            (state.currentUser.permissions || []).includes('user:manage')
        ));
        btn?.classList.toggle('hidden', !can);
    } catch (_) {
        state.currentUser = null;
        btn?.classList.add('hidden');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
