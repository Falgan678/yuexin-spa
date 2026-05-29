// 数据统计模块 - 访问统计和用户行为分析
export function initAnalytics() {
    // 生成会话ID
    const sessionId = getOrCreateSessionId();
    
    // 页面加载时记录访问
    trackPageView();
    
    // 监听服务卡片点击
    trackServiceViews();
    
    // 监听按钮点击
    trackButtonClicks();
    
    // 监听页面停留时间
    trackPageDuration();
    
    // 监听滚动深度
    trackScrollDepth();
}

// 获取或创建会话ID
function getOrCreateSessionId() {
    let sessionId = sessionStorage.getItem('spa_session_id');
    if (!sessionId) {
        sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem('spa_session_id', sessionId);
    }
    return sessionId;
}

// 发送统计事件到后端
async function trackEvent(eventType, eventData = {}) {
    try {
        const sessionId = getOrCreateSessionId();
        const data = {
            event_type: eventType,
            event_data: eventData,
            page_url: window.location.href,
            referrer: document.referrer,
            session_id: sessionId
        };
        
        await fetch('/api/analytics', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });
    } catch (error) {
        // 统计失败不影响用户体验，静默处理
        console.debug('Analytics tracking failed:', error);
    }
}

// 记录页面访问
function trackPageView() {
    trackEvent('page_view', {
        title: document.title,
        path: window.location.pathname,
        timestamp: new Date().toISOString()
    });
}

// 监听服务卡片查看
function trackServiceViews() {
    const serviceCards = document.querySelectorAll('.service-card');
    
    // 使用Intersection Observer监听服务卡片进入视口
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const serviceType = entry.target.dataset.service;
                if (serviceType) {
                    trackEvent('service_view', {
                        service: serviceType,
                        timestamp: new Date().toISOString()
                    });
                    // 只记录一次
                    observer.unobserve(entry.target);
                }
            }
        });
    }, {
        threshold: 0.5 // 50%可见时触发
    });
    
    serviceCards.forEach(card => observer.observe(card));
}

// 监听按钮点击
function trackButtonClicks() {
    // 预约按钮
    document.querySelectorAll('.book-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const serviceCard = btn.closest('.service-card');
            const serviceType = serviceCard ? serviceCard.dataset.service : 'unknown';
            trackEvent('booking_click', {
                service: serviceType,
                button_type: 'service_card',
                timestamp: new Date().toISOString()
            });
        });
    });
    
    // 优惠按钮
    document.querySelectorAll('.offer-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const offerCard = btn.closest('[class*="gradient"]');
            const offerTitle = offerCard ? offerCard.querySelector('h3')?.textContent : 'unknown';
            trackEvent('offer_click', {
                offer: offerTitle,
                timestamp: new Date().toISOString()
            });
        });
    });
    
    // 电话按钮
    document.querySelectorAll('a[href^="tel:"]').forEach(link => {
        link.addEventListener('click', () => {
            trackEvent('phone_click', {
                phone: link.href.replace('tel:', ''),
                timestamp: new Date().toISOString()
            });
        });
    });
    
    // 导航按钮
    const navBtn = document.getElementById('navBtn');
    if (navBtn) {
        navBtn.addEventListener('click', () => {
            trackEvent('navigation_click', {
                timestamp: new Date().toISOString()
            });
        });
    }
    
    // 菜单链接
    document.querySelectorAll('.menu-link').forEach(link => {
        link.addEventListener('click', () => {
            const section = link.getAttribute('href');
            trackEvent('menu_click', {
                section: section,
                timestamp: new Date().toISOString()
            });
        });
    });
}

// 监听页面停留时间
function trackPageDuration() {
    let startTime = Date.now();
    
    // 页面卸载时记录停留时间
    window.addEventListener('beforeunload', () => {
        const duration = Math.floor((Date.now() - startTime) / 1000); // 秒
        trackEvent('page_duration', {
            duration: duration,
            timestamp: new Date().toISOString()
        });
    });
    
    // 页面隐藏时也记录（用户切换标签页）
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            const duration = Math.floor((Date.now() - startTime) / 1000);
            trackEvent('page_hidden', {
                duration: duration,
                timestamp: new Date().toISOString()
            });
        } else {
            // 页面重新可见时重置开始时间
            startTime = Date.now();
        }
    });
}

// 监听滚动深度
function trackScrollDepth() {
    let maxScrollDepth = 0;
    let scrollDepthMarks = [25, 50, 75, 100];
    let trackedMarks = new Set();
    
    function calculateScrollDepth() {
        const windowHeight = window.innerHeight;
        const documentHeight = document.documentElement.scrollHeight;
        const scrollTop = window.scrollY;
        const scrollDepth = Math.floor(((scrollTop + windowHeight) / documentHeight) * 100);
        
        return Math.min(scrollDepth, 100);
    }
    
    function handleScroll() {
        const currentDepth = calculateScrollDepth();
        
        if (currentDepth > maxScrollDepth) {
            maxScrollDepth = currentDepth;
        }
        
        // 记录滚动深度里程碑
        scrollDepthMarks.forEach(mark => {
            if (currentDepth >= mark && !trackedMarks.has(mark)) {
                trackedMarks.add(mark);
                trackEvent('scroll_depth', {
                    depth: mark,
                    timestamp: new Date().toISOString()
                });
            }
        });
    }
    
    // 使用节流优化性能
    let scrollTimeout;
    window.addEventListener('scroll', () => {
        if (scrollTimeout) {
            clearTimeout(scrollTimeout);
        }
        scrollTimeout = setTimeout(handleScroll, 200);
    });
    
    // 页面卸载时记录最大滚动深度
    window.addEventListener('beforeunload', () => {
        trackEvent('max_scroll_depth', {
            depth: maxScrollDepth,
            timestamp: new Date().toISOString()
        });
    });
}

// 导出工具函数供其他模块使用
export function trackCustomEvent(eventType, eventData) {
    trackEvent(eventType, eventData);
}