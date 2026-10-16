/*
 * geo_guard.js —— 坐标入口消毒：挡住「定位退化」与「两路定位源横跳」
 *
 * 这份代码只做一件事：**在坐标进入数据模型之前把伪影挡掉**。
 * 它不生成轨迹、不驱动定位源、不碰上报字段 —— 只做入口校验。
 *
 * 背景问题（移动端定位自动化的三个经典伪影）
 * ─────────────────────────────────────────
 * ① 退化定位
 *    没有真实定位时，定位 SDK 会退回网络定位 / 上一次缓存 / 默认城市。
 *    实测会出现一个离目标区域 800+ km 的点，而且常常正好补记在「停止」那一刻，
 *    于是整条记录带一个一眼假的把柄。
 *
 * ② 两路定位源横跳（最反直觉，也最难查）
 *    注入的真实点与 SDK 退化点会**交替**进入数据模型。
 *    两个点**单个看都合法**（都在合理半径内），所以只做「越界检查」根本拦不住。
 *    界面表现为坐标来回闪现 + 平移。
 *
 * ③ 起跑阶段被误判
 *    如果消毒器用「单次位移超阈值就判假」，而它锚定的上一个点来自**上一轮**，
 *    那么新一轮的正常起点（随机撒点，可能离旧锚点 500~900 m）会被当跳变拦掉，
 *    位置被"冻"在旧点上、过几秒又放开 —— 表现为**先平移、再瞬移**。
 *
 * 三层防线（按优先级）
 * ───────────────────
 *   ① 越界半径     ：离区域中心超过 RADIUS_M 一律替换为上一个合法点（挡住量级错误）
 *   ② 起跑重新锚定 ：进入"跑动中"之前**不判跳变**，遇到远处的新点直接重新锚定
 *   ③ 保持期       ：锚定一个源后，整轮拒绝离它超过 HOLD_M 的点（挡双源横跳）
 *
 * ★ 阈值标定的经验（比代码更重要）
 * ─────────────────────────────────
 *   · 阈值必须按**真实采样间隔**标定，不能想当然。轨迹表里相邻两行可以差 900 m,
 *     那不是假点、是稀疏采样 —— 早期把跳变阈值定在 600 m 会**误杀正常轮次**。
 *     抓精细漂移要看**连续采样表**，不要看稀疏表。
 *   · 消毒器必须能**自证在工作**：钩子静默失效是这类项目最贵的坑。
 *     所以带一个心跳，定期打印计数与当前锚点，出问题一眼看出是"没挂上"还是"在拦"。
 *   · **不要跨调用缓存对象引用**（尤其 JNI/jobject），只抄标量/字符串；
 *     否则会触发宿主运行时硬中止，进程连钩子一起没。
 *
 * 用法
 * ────
 *   这份文件是一个独立 IIFE 片段，设计为被**拼装脚本**注入到目标进程后立即生效。
 *   占位符（<REGION_*_LAT> 等）需要替换成你的目标区域参数。
 *
 * 许可
 * ────
 *   MIT。仅作入口校验的工程参考，不含任何"让上报数据自洽"的机制。
 */
(function () {
    'use strict';

    /* ── 参数（★ 占位符，**必须先替换**，否则消毒器会静默失效！）────────────
     *
     * ⚠️ 为什么这里写成 `parseFloat('<...>')`：
     *    是为了让文件**天然就是合法 JS**，可以直接过 `node --check` / 语法高亮 / CI，
     *    不用先替换占位符才能做静态检查。
     *
     * ⚠️⚠️ 但它的代价是：**忘记替换就得到 NaN**，而 NaN 会让所有比较都变成 false ——
     *    `dist()` 返回 NaN、`d > RADIUS_M` 永远不成立 ⇒ 消毒器"挂上了但什么都没拦"，
     *    也就是本领域最贵的那种故障：**静默失效**。
     *
     *    所以下面有一个 `assertConfigured()` 启动自检：参数没替换就**大声报错**，
     *    而不是安静地放过所有坐标。原始项目里这个坑真实发生过（钩子日志显示"已接管"，
     *    但拦截计数永远是 0，排查了很久）。
     */
    var REGION_LAT = parseFloat('<REGION_CENTER_LAT>');   /* 目标区域中心纬度 */
    var REGION_LNG = parseFloat('<REGION_CENTER_LNG>');   /* 目标区域中心经度 */
    var RADIUS_M = 1500.0;      /* 越界半径：区域最远活动范围 + 余量 */
    var MAX_JUMP_M = 500.0;     /* 跳变阈值（只在"跑动中"生效，见防线②）*/
    var SEED_M = 900.0;         /* 超过它认为"这是新一轮起点/重新定位"，不是跳变 */
    var HOLD_M = 100.0;         /* 保持期阈值：真人单次采样不可能移动 100 m */
    var HOLD_S = 1800.0;        /* 保持期时长（覆盖整轮）*/

    /* ── 启动自检：宁可炸掉，也不要静默放过 ────────────────────────────── */
    var CONFIG_OK = true;
    (function assertConfigured() {
        var bad = [];
        if (!isFinite(REGION_LAT) || REGION_LAT === 0) bad.push("REGION_LAT");
        if (!isFinite(REGION_LNG) || REGION_LNG === 0) bad.push("REGION_LNG");
        if (!isFinite(RADIUS_M) || RADIUS_M <= 0) bad.push("RADIUS_M");
        [["MAX_JUMP_M", MAX_JUMP_M], ["SEED_M", SEED_M],
         ["HOLD_M", HOLD_M], ["HOLD_S", HOLD_S]].forEach(function (kv) {
            if (!isFinite(kv[1]) || kv[1] <= 0) bad.push(kv[0]);
        });
        if (bad.length) {
            CONFIG_OK = false;
            console.log('[guard] ✗✗ 参数未配置：' + bad.join(', ')
                + ' —— 消毒器将**拒绝工作**（不接管任何坐标入口），'
                + '以免"看起来挂上了、实际上什么都没拦"。'
                + ' 请替换文件顶部的 <REGION_CENTER_LAT> / <REGION_CENTER_LNG> 等占位符。');
        } else {
            console.log('[guard] 参数自检通过：中心=' + REGION_LAT.toFixed(6) + ',' + REGION_LNG.toFixed(6)
                + ' 越界=' + RADIUS_M + 'm 跳变=' + MAX_JUMP_M + 'm 保持=' + HOLD_M + 'm/' + HOLD_S + 's');
        }
    })();

    var lastGood = [REGION_LAT, REGION_LNG];
    var running = false;        /* 是否已进入"跑动中"（收到近距离坐标后置 true）*/
    var anchorAt = 0;           /* 当前锚点确立时间 */
    var holding = false;        /* 是否已进入保持期 */

    var nPassed = 0, nOutOfRange = 0, nJumped = 0, nReseeded = 0, nHeld = 0;

    /* ── 距离计算（等距圆柱近似，米级足够）────────────────────────────── */
    function dist(la, ln) {
        var dy = (la - REGION_LAT) * 111320.0;
        var dx = (ln - REGION_LNG) * 111320.0 * Math.cos(REGION_LAT * Math.PI / 180.0);
        return Math.sqrt(dx * dx + dy * dy);
    }

    function dist2(a, b) {
        var dy = (a[0] - b[0]) * 111320.0;
        var dx = (a[1] - b[1]) * 111320.0 * Math.cos(REGION_LAT * Math.PI / 180.0);
        return Math.sqrt(dx * dx + dy * dy);
    }

    /* ── 核心：入口消毒 ──────────────────────────────────────────────── */
    function sanitize(la, ln) {
        /* 非法值 / 空定位：退回上一个合法点，绝不放 NaN 进去 */
        if (typeof la !== 'number' || typeof ln !== 'number' || isNaN(la) || isNaN(ln)) {
            return lastGood.slice();
        }
        if (la === 0 && ln === 0) return lastGood.slice();

        /* 防线① 越界半径 —— 挡住"退化到别的城市"这类量级错误。
         *         这是主闸门：800+ km 的点任何阈值都拦得住。 */
        var d = dist(la, ln);
        if (d > RADIUS_M) {
            nOutOfRange++;
            if (nOutOfRange <= 10 || nOutOfRange % 50 === 0) {
                console.log('[guard] 拦掉越界坐标 ' + la.toFixed(6) + ',' + ln.toFixed(6)
                    + '（离区域 ' + Math.round(d) + ' m）→ 用上一个合法点 '
                    + lastGood[0].toFixed(6) + ',' + lastGood[1].toFixed(6)
                    + '（累计 ' + nOutOfRange + ' 次）');
            }
            return lastGood.slice();
        }

        var j = dist2([la, ln], lastGood);

        /* 防线③ 保持期 —— 挡"两路定位源横跳"。
         *   ★ 这一层必须在防线②**之前**判：因为横跳的两个点都合法，
         *     而且每次都会"重新锚定"，不先锁住就会一直来回跳。
         *   ★ 真人任何一次采样都不可能移动 HOLD_M（100 m），所以整轮用它是安全的；
         *     而两个源相距 ~900 m，必然被拦掉一个。
         */
        if (holding && (Date.now() - anchorAt) < HOLD_S * 1000) {
            if (j > HOLD_M) {
                nHeld++;
                if (nHeld <= 8 || nHeld % 100 === 0) {
                    console.log('[guard] 保持期拦掉另一路定位源 ' + la.toFixed(6) + ',' + ln.toFixed(6)
                        + '（距当前锚点 ' + Math.round(j) + ' m，锚点 '
                        + lastGood[0].toFixed(6) + ',' + lastGood[1].toFixed(6)
                        + '；累计 ' + nHeld + ' 次）');
                }
                return lastGood.slice();
            }
        }

        /* 防线② 起跑阶段：**不判跳变**，直接重新锚定。
         *   ★ 这是修"先平移、再瞬移"的关键。每轮起点是随机撒的，
         *     而 lastGood 还停在上一轮末尾；如果这里按跳变拦，
         *     正常起点会被当成假点，位置冻在旧点上、过几秒又放开。
         */
        if (!running) {
            if (j > SEED_M) {
                nReseeded++;
                console.log('[guard] 起跑阶段重新锚定 ' + la.toFixed(6) + ',' + ln.toFixed(6)
                    + '（距旧锚点 ' + Math.round(j) + ' m）—— 视为本轮起点，不按跳变拦'
                    + '（累计 ' + nReseeded + ' 次）');
            }
            lastGood = [la, ln];
            anchorAt = Date.now();
            holding = true;
            nPassed++;
            return [la, ln];
        }

        /* 跑动中的跳变保护：这时相邻采样应该只差十几米，
         * 跳 MAX_JUMP_M 必是假点。 */
        if (j > MAX_JUMP_M) {
            nJumped++;
            if (nJumped <= 10 || nJumped % 50 === 0) {
                console.log('[guard] 拦掉跳变坐标 ' + la.toFixed(6) + ',' + ln.toFixed(6)
                    + '（距上一个合法点 ' + Math.round(j) + ' m）→ 保留上一个点'
                    + '（累计 ' + nJumped + ' 次）');
            }
            return lastGood.slice();
        }

        if (!running && j <= SEED_M) running = true;   /* 确认"跑起来了" */
        lastGood = [la, ln];
        anchorAt = Date.now();
        holding = true;
        nPassed++;
        return [la, ln];
    }

    /* ── 心跳：让运维一眼看出消毒器到底有没有在工作 ──────────────────────
     *   钩子静默失效是本领域最贵的坑（表现为"什么都正常，就是没效果"）。
     *   心跳同时给出所有计数，能直接区分"没挂上(全 0 且不动)"
     *   与"在拦(拦截计数在涨)"。
     */
    function heartbeat() {
        console.log('[guard] 心跳 通过=' + nPassed + ' 越界拦截=' + nOutOfRange
            + ' 跳变拦截=' + nJumped + ' 保持拦截=' + nHeld + ' 重新锚定=' + nReseeded
            + ' 跑动中=' + (running ? '是' : '否')
            + ' 当前合法点=' + lastGood[0].toFixed(6) + ',' + lastGood[1].toFixed(6));
    }
    setInterval(heartbeat, 20000);

    /* ── 挂钩：把消毒器接到坐标入口上 ──────────────────────────────────
     *   原则：
     *     · 只接管**构造与 setter**（数据进入模型的那一点），不碰读取端；
     *     · 类可能还没加载 ⇒ 用定时器轮询 `Java.use`，成功即 clearInterval；
     *     · 全程 try/catch，钩子抛异常会触发目标自身的崩溃处理，得不偿失。
     *   注：下面用的是 Frida 的 Java 桥（`Java.use` / `Java.choose` / `$init`）。
     */
    var TARGET_CLASS = '<TARGET_COORD_CLASS>';   /* 例如某 SDK 的坐标实体类 */

    function hookCoordClass(C) {
        var hooked = 0;
        /* 构造 (double, double) */
        try {
            C.$init.overload('double', 'double').implementation = function (la, ln) {
                var p = sanitize(la, ln);
                return this.$init(p[0], p[1]);
            };
            hooked++;
        } catch (e) { }
        /* 构造 (String, String)（有些实现用字符串传坐标）*/
        try {
            C.$init.overload('java.lang.String', 'java.lang.String').implementation = function (la, ln) {
                var p = sanitize(parseFloat(la), parseFloat(ln));
                return this.$init(String(p[0]), String(p[1]));
            };
            hooked++;
        } catch (e) { }
        return hooked > 0;
    }

    Java.perform(function () {
        /* ★ 参数没配置就**不接管任何入口**：让故障以"什么都没发生"以外的形式暴露出来。
         *   原始项目里踩过的坑就是"钩子报已接管、拦截计数永远 0"，
         *   看起来一切正常、实际完全没生效。 */
        if (!CONFIG_OK) {
            console.log('[guard] 已跳过挂钩：参数未配置（见上面的报错）。');
            return;
        }
        var tries = 0;
        var timer = setInterval(function () {
            tries++;
            var C = null;
            try { C = Java.use(TARGET_CLASS); } catch (e) { }
            if (C) {
                if (hookCoordClass(C)) {
                    console.log('[guard] 已接管 ' + TARGET_CLASS + ' 构造（第 ' + tries + ' 次尝试）');
                }
                /* setter：字段名/签名按实际情况调整；每个签名单独 try，
                 * 失败不影响其它签名（这里是最容易踩空的地方）。 */
                ['setLatitude', 'setLongitude'].forEach(function (fn) {
                    try {
                        var m = C[fn];
                        if (!m) return;
                        var types = ['double', 'float', 'java.lang.Double', 'java.lang.String'];
                        for (var i = 0; i < types.length; i++) {
                            try {
                                m.overload(types[i]).implementation = function (v) {
                                    var la = null, ln = null;
                                    try { la = this.getLatitude(); ln = this.getLongitude(); } catch (e) { }
                                    if (la === null || ln === null) return m.call(this, v);
                                    var cur = [Number(la), Number(ln)];
                                    if (fn === 'setLatitude') cur[0] = Number(v); else cur[1] = Number(v);
                                    var p = sanitize(cur[0], cur[1]);
                                    var w = (fn === 'setLatitude') ? p[0] : p[1];
                                    if (types[i] === 'java.lang.String') return m.call(this, String(w));
                                    return m.call(this, w);
                                };
                                console.log('[guard] 已接管 ' + TARGET_CLASS + '.' + fn + '(' + types[i] + ')');
                                break;
                            } catch (e) { }
                        }
                    } catch (e) { }
                });
                clearInterval(timer);
                return;
            }
            if (tries >= 60) {
                clearInterval(timer);
                console.log('[guard] 放弃：' + TARGET_CLASS + ' 一直没加载');
            }
        }, 2000);
    });
})();
