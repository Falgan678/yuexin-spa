// 菜单模块 - 顶栏抽屉
export function initMenu() {
    const menuBtn = document.getElementById('menuBtn');
    const sideMenu = document.getElementById('sideMenu');
    const closeMenuBtn = document.getElementById('closeMenuBtn');
    const overlay = document.getElementById('overlay');

    if (!menuBtn || !sideMenu) return;

    function open() {
        sideMenu.classList.add('open');
        overlay && overlay.classList.add('show');
        document.body.style.overflow = 'hidden';
    }
    function close() {
        sideMenu.classList.remove('open');
        overlay && overlay.classList.remove('show');
        document.body.style.overflow = '';
    }

    menuBtn.addEventListener('click', open);
    closeMenuBtn && closeMenuBtn.addEventListener('click', close);
    overlay && overlay.addEventListener('click', close);

    // 点击菜单项关闭
    sideMenu.querySelectorAll('a').forEach(a => a.addEventListener('click', close));

    // ESC 关闭
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && sideMenu.classList.contains('open')) close();
    });
}
