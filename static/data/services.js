// 服务目录数据 - 单一数据源，便于扩展与维护
export const CATEGORIES = [
    { id: 'all',      name: '全部项目', icon: 'fa-spa' },
    { id: 'chinese',  name: '中式调理', icon: 'fa-yin-yang' },
    { id: 'thai',     name: '泰式 SPA', icon: 'fa-leaf' },
    { id: 'aroma',    name: '芳疗护理', icon: 'fa-pump-soap' },
    { id: 'foot',     name: '足疗保健', icon: 'fa-shoe-prints' },
];

export const TAGS = [
    { id: 'hot',      label: '热门',     color: 'bg-rose-500'    },
    { id: 'new',      label: '新品',     color: 'bg-emerald-500' },
    { id: 'female',   label: '女士专享', color: 'bg-pink-500'    },
    { id: 'couple',   label: '情侣套餐', color: 'bg-violet-500'  },
    { id: 'recommend',label: '主推',     color: 'bg-amber-500'   },
];

// 时长筛选
export const DURATIONS = [
    { id: 'all',     label: '全部时长', min: 0,   max: 9999 },
    { id: 'short',   label: '30 分钟',  min: 0,   max: 45   },
    { id: 'medium',  label: '60 分钟',  min: 46,  max: 75   },
    { id: 'long',    label: '90 分钟',  min: 76,  max: 105  },
    { id: 'extra',   label: '120+ 分钟', min: 106, max: 9999 },
];

// 价格区间
export const PRICE_RANGES = [
    { id: 'all',  label: '全部价格',     min: 0,   max: 99999 },
    { id: 'p1',   label: '¥99 以下',     min: 0,   max: 98    },
    { id: 'p2',   label: '¥99 - ¥199',   min: 99,  max: 199   },
    { id: 'p3',   label: '¥199 - ¥399',  min: 199, max: 399   },
    { id: 'p4',   label: '¥399 以上',    min: 399, max: 99999 },
];

// 排序
export const SORT_OPTIONS = [
    { id: 'default',    label: '综合推荐' },
    { id: 'hot',        label: '人气优先' },
    { id: 'price_asc',  label: '价格从低到高' },
    { id: 'price_desc', label: '价格从高到低' },
    { id: 'duration',   label: '时长从短到长' },
];

// 服务项目 - 16 项，覆盖 4 大类
// 图片使用本地高清资产，避免远程压缩、失效或跨域加载导致的模糊/空白。
const IMG = {
    cnMeridian:      'assets/images/service-cn-meridian.jpg',
    cnCupping:       'assets/images/service-cn-cupping.jpg',
    cnHerbal:        'assets/images/service-cn-herbal.jpg',
    cnChild:         'assets/images/service-cn-child.jpg',
    thaiClassic:     'assets/images/service-thai-classic.jpg',
    thaiRoyal:       'assets/images/service-thai-royal.jpg',
    thaiHotstone:    'assets/images/service-thai-hotstone.jpg',
    thaiFourhands:   'assets/images/service-thai-fourhands.jpg',
    aromaFullbody:   'assets/images/service-aroma-fullbody.jpg',
    aromaBack:       'assets/images/service-aroma-back.jpg',
    aromaLymph:      'assets/images/service-aroma-lymph.jpg',
    aromaFacial:     'assets/images/service-aroma-facial.jpg',
    footReflexology: 'assets/images/service-foot-reflexology.jpg',
    footHerbalBath:  'assets/images/service-foot-herbalbath.jpg',
    footShoulder:    'assets/images/service-foot-shoulder.jpg',
    footHeadSpa:     'assets/images/service-foot-headspa.jpg',
};

export const SERVICES = [
    // ---------- 中式调理 ----------
    {
        id: 's-cn-1', category: 'chinese', name: '经络推拿',
        subtitle: '传统手法 · 疏通经络', image: IMG.cnMeridian,
        duration: 60, price: 198, originalPrice: 268, popularity: 95,
        tags: ['hot', 'recommend'],
        effects: ['疏通经络', '缓解肌肉疲劳', '改善血液循环'],
        suitableFor: '久坐人群、肩颈僵硬',
        description: '采用传统中医推拿手法，以揉、按、滚、点为主，配合穴位刺激，深度疏通经络，缓解长期久坐带来的肩颈与腰背不适。',
    },
    {
        id: 's-cn-2', category: 'chinese', name: '刮痧拔罐',
        subtitle: '祛湿排毒 · 行气活血', image: IMG.cnCupping,
        duration: 45, price: 158, originalPrice: 218, popularity: 78,
        tags: ['recommend'],
        effects: ['祛湿排寒', '行气活血', '舒缓疲劳'],
        suitableFor: '湿气重、易疲劳人群',
        description: '采用纯铜砭板与玻璃火罐，沿膀胱经走罐刮痧，帮助代谢体内湿浊，激活背部阳气。',
    },
    {
        id: 's-cn-3', category: 'chinese', name: '艾灸调理',
        subtitle: '温阳散寒 · 滋补元气', image: IMG.cnHerbal,
        duration: 60, price: 188, originalPrice: 258, popularity: 82,
        tags: ['female'],
        effects: ['温阳散寒', '调理宫寒', '提升免疫'],
        suitableFor: '宫寒、手脚冰凉、体虚',
        description: '选用三年陈艾绒，依据经络辨证选穴，借灸火之力深透经络，温补阳气，特别适合体虚、宫寒女性。',
    },
    {
        id: 's-cn-4', category: 'chinese', name: '小儿推拿',
        subtitle: '绿色调理 · 增强体质', image: IMG.cnChild,
        duration: 30, price: 128, originalPrice: 168, popularity: 65,
        tags: ['new'],
        effects: ['增强免疫', '健脾开胃', '改善睡眠'],
        suitableFor: '3-12 岁儿童',
        description: '由国家认证小儿推拿师施术，全程无针无药，针对儿童积食、感冒、咳嗽、睡眠不佳等常见问题进行温和调理。',
    },

    // ---------- 泰式 SPA ----------
    {
        id: 's-th-1', category: 'thai', name: '泰式古法',
        subtitle: '异域风情 · 深度放松', image: IMG.thaiClassic,
        duration: 90, price: 268, originalPrice: 358, popularity: 91,
        tags: ['hot'],
        effects: ['深度放松', '柔韧筋骨', '释放压力'],
        suitableFor: '久坐、运动量少人群',
        description: '由泰国本土资深技师施术，融合按压、拉伸与瑜伽手法，全身经络深度梳理，一次相当于做了三小时瑜伽。',
    },
    {
        id: 's-th-2', category: 'thai', name: '皇家泰式 SPA',
        subtitle: '尊享体验 · 全程一对一', image: IMG.thaiRoyal,
        duration: 120, price: 588, originalPrice: 798, popularity: 88,
        tags: ['recommend', 'couple'],
        effects: ['全身放松', '改善睡眠', '尊享体验'],
        suitableFor: '高品质追求者',
        description: '120 分钟皇家级享受，含足浴、全身按摩、香薰头疗与花瓣浴，一对一资深技师全程服务。',
    },
    {
        id: 's-th-3', category: 'thai', name: '热石能量按摩',
        subtitle: '玄武岩 · 深层热疗', image: IMG.thaiHotstone,
        duration: 75, price: 328, originalPrice: 458, popularity: 76,
        tags: ['new'],
        effects: ['温通经络', '深层放松', '改善循环'],
        suitableFor: '寒性体质、肌肉紧张',
        description: '采用 55°C 玄武岩热石沿经络滑行，热力深透肌理，对寒性体质与运动后僵硬尤其有效。',
    },
    {
        id: 's-th-4', category: 'thai', name: '四手联弹按摩',
        subtitle: '双人技师 · 极致享受', image: IMG.thaiFourhands,
        duration: 90, price: 488, originalPrice: 668, popularity: 70,
        tags: ['couple', 'new'],
        effects: ['左右同步', '极致放松', '尊享体验'],
        suitableFor: '追求极致体验',
        description: '两位训练有素的技师左右同步施术，节奏如音乐般和谐，是一次远超预期的感官旅程。',
    },

    // ---------- 芳疗护理 ----------
    {
        id: 's-ar-1', category: 'aroma', name: '精油全身 SPA',
        subtitle: '芳香疗法 · 身心愉悦', image: IMG.aromaFullbody,
        duration: 90, price: 328, originalPrice: 458, popularity: 93,
        tags: ['hot', 'female'],
        effects: ['舒缓身心', '美容养颜', '改善睡眠'],
        suitableFor: '压力大、皮肤干燥',
        description: '选用法国 Decléor 进口纯天然单方精油，根据当下身体状态调香，配合芳疗师专业手法，让身心同时回到平衡。',
    },
    {
        id: 's-ar-2', category: 'aroma', name: '香薰背部护理',
        subtitle: '深层清洁 · 焕亮肤质', image: IMG.aromaBack,
        duration: 60, price: 268, originalPrice: 358, popularity: 80,
        tags: ['female'],
        effects: ['清洁毛孔', '改善背痘', '焕亮肤质'],
        suitableFor: '背部痤疮、肤色暗沉',
        description: '深层去角质 + 蒸汽舒缓 + 精油按摩 + 海藻面膜，让后背重回光洁。',
    },
    {
        id: 's-ar-3', category: 'aroma', name: '淋巴排毒按摩',
        subtitle: '雕塑身形 · 加速代谢', image: IMG.aromaLymph,
        duration: 75, price: 358, originalPrice: 488, popularity: 85,
        tags: ['female', 'recommend'],
        effects: ['消除水肿', '雕塑身形', '加速代谢'],
        suitableFor: '水肿、代谢慢',
        description: '专业淋巴引流手法 + 葡萄柚迷迭香精油，针对腿部、腹部、手臂水肿进行精准引流。',
    },
    {
        id: 's-ar-4', category: 'aroma', name: '面部芳疗护理',
        subtitle: '法式手法 · 抗衰养肤', image: IMG.aromaFacial,
        duration: 60, price: 298, originalPrice: 398, popularity: 79,
        tags: ['female', 'new'],
        effects: ['提拉紧致', '改善暗沉', '深层补水'],
        suitableFor: '初老肌、暗沉肌',
        description: '采用法式手雕脸部按摩手法，配合玫瑰、橙花、乳香精油，唤醒肌肤紧致与光泽。',
    },

    // ---------- 足疗保健 ----------
    {
        id: 's-ft-1', category: 'foot', name: '中式足底按摩',
        subtitle: '反射疗法 · 养生保健', image: IMG.footReflexology,
        duration: 45, price: 99, originalPrice: 158, popularity: 90,
        tags: ['hot'],
        effects: ['调理脏腑', '促进代谢', '增强免疫'],
        suitableFor: '所有人群',
        description: '基于中医反射学，刺激足底 60+ 反射区，配合中药足浴，性价比之选。',
    },
    {
        id: 's-ft-2', category: 'foot', name: '中药养生足浴',
        subtitle: '十二经络 · 由足入身', image: IMG.footHerbalBath,
        duration: 60, price: 138, originalPrice: 198, popularity: 75,
        tags: ['recommend'],
        effects: ['驱寒祛湿', '助眠安神', '舒缓疲劳'],
        suitableFor: '失眠、足部冰凉',
        description: '使用艾叶、生姜、藏红花等 12 味中药包，65°C 恒温足浴 30 分钟 + 30 分钟足底点按。',
    },
    {
        id: 's-ft-3', category: 'foot', name: '肩颈头部调理',
        subtitle: '深度放松 · 缓解头痛', image: IMG.footShoulder,
        duration: 30, price: 88, originalPrice: 128, popularity: 86,
        tags: ['hot'],
        effects: ['缓解头痛', '改善失眠', '放松肩颈'],
        suitableFor: '电脑族、头痛人群',
        description: '专为长时间面对屏幕的人设计，针对斜方肌、肩胛提肌进行深度松解，30 分钟立刻轻松。',
    },
    {
        id: 's-ft-4', category: 'foot', name: '印度头部 SPA',
        subtitle: '香薰头疗 · 重塑发质', image: IMG.footHeadSpa,
        duration: 60, price: 188, originalPrice: 268, popularity: 72,
        tags: ['new', 'female'],
        effects: ['改善脱发', '舒缓头皮', '安神助眠'],
        suitableFor: '脱发、用脑过度',
        description: '印度阿育吠陀传统头部按摩，配合椰子油与迷迭香精油，深度疏通头皮气血。',
    },
];

// 提供给详情页和后端 service_type 字段使用的中文名（与后端 ALLOWED_SERVICES 保持兼容）
// 后端目前允许：中式推拿 / 泰式古法 / 精油SPA / 足底按摩
// 这里做一次映射，让前端选了任何项目，最终提交的 service_type 都落在白名单内
export const CATEGORY_TO_BACKEND_SERVICE = {
    chinese: '中式推拿',
    thai:    '泰式古法',
    aroma:   '精油SPA',
    foot:    '足底按摩',
};
