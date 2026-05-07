(function () {
    'use strict';

    var PLUGIN_VERSION = '0.6.0';
    var REPORT_ENDPOINT_KEY = 'tizen_debug_report_url';
    var REPORT_ENDPOINT_DEFAULT = 'https://shakespeare-eden-composition-aluminum.trycloudflare.com/report';

    function reportEndpoint() {
        try {
            if (window.Lampa && Lampa.Storage && Lampa.Storage.field) {
                return Lampa.Storage.field(REPORT_ENDPOINT_KEY) || REPORT_ENDPOINT_DEFAULT;
            }
        } catch (e) {}
        return REPORT_ENDPOINT_DEFAULT;
    }

    function safe(fn, fallback) {
        try { return fn(); }
        catch (e) { return fallback !== undefined ? fallback : ('<error: ' + e.message + '>'); }
    }

    function describeValue(val, depth, maxDepth) {
        if (val === null) return 'null';
        if (val === undefined) return 'undefined';
        var t = typeof val;
        if (t === 'function') return '[function]';
        if (t !== 'object') return t + ': ' + String(val).slice(0, 200);
        if (depth >= maxDepth) return '[object …]';
        var out = {};
        var keys = safe(function () { return Object.getOwnPropertyNames(val); }, []);
        try {
            for (var k in val) if (keys.indexOf(k) < 0) keys.push(k);
        } catch (e) {}
        keys.sort();
        keys.forEach(function (k) {
            try { out[k] = describeValue(val[k], depth + 1, maxDepth); }
            catch (e) { out[k] = '<error: ' + e.message + '>'; }
        });
        return out;
    }

    var QUICK_CHECKS = [
        'webapis',
        'tizen',
        'webapis.allshare',
        'webapis.network',
        'webapis.productinfo',
        'tizen.systeminfo',
        'tizen.network',
        'tizen.filesystem',
        'tizen.application',
        'tizen.SocketAddress',
        'tizen.UDPSocket',
        'tizen.TCPSocket'
    ];

    var TIZEN_CAPABILITIES = [
        'http://tizen.org/feature/platform.version',
        'http://tizen.org/feature/platform.web.api.version',
        'http://tizen.org/feature/platform.native.api.version',
        'http://tizen.org/feature/platform.core.cpu.arch',
        'http://tizen.org/system/model_name',
        'http://tizen.org/system/build.string',
        'http://tizen.org/system/manufacturer',
        'http://tizen.org/system/platform.name',
        'http://tizen.org/feature/network.upnp',
        'http://tizen.org/feature/network.dlna',
        'http://tizen.org/feature/network.wifi',
        'http://tizen.org/feature/network.ethernet'
    ];

    function resolvePath(path) {
        var parts = path.split('.');
        var cur = window;
        for (var i = 0; i < parts.length; i++) {
            if (cur == null) return undefined;
            try { cur = cur[parts[i]]; }
            catch (e) { return '<error: ' + e.message + '>'; }
        }
        return cur;
    }

    function quickCheck(path) {
        var v = resolvePath(path);
        if (v === undefined) return { ok: false, summary: 'undefined' };
        if (v === null) return { ok: false, summary: 'null' };
        var t = typeof v;
        if (t !== 'object' && t !== 'function') return { ok: true, summary: t + ': ' + String(v) };
        var keys = safe(function () { return Object.getOwnPropertyNames(v); }, []);
        return { ok: true, summary: t + ' [' + keys.length + ' props]', keys: keys.slice(0, 50) };
    }

    function readSysteminfo() {
        var sys = {};
        var ti = resolvePath('tizen.systeminfo');
        if (!ti || typeof ti.getCapability !== 'function') {
            return { error: 'tizen.systeminfo.getCapability недоступен' };
        }
        TIZEN_CAPABILITIES.forEach(function (cap) {
            sys[cap] = safe(function () { return ti.getCapability(cap); });
        });
        return sys;
    }

    function readProductinfo() {
        var pi = resolvePath('webapis.productinfo');
        if (!pi) return { error: 'webapis.productinfo недоступен' };
        var methods = ['getModel', 'getModelCode', 'getFirmware', 'getRealModel',
                       'getDuid', 'getVersion', 'getSerialNumber',
                       'is8KPanelSupported', 'isUdPanelSupported', 'getSmartTVServerType'];
        var out = {};
        methods.forEach(function (m) {
            out[m] = safe(function () { return typeof pi[m] === 'function' ? pi[m]() : pi[m]; });
        });
        return out;
    }

    function buildReport() {
        var report = {
            ts: new Date().toISOString(),
            plugin: PLUGIN_VERSION,
            ua: navigator.userAgent,
            href: location.href,
            screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
            lampa: {},
            quickChecks: {},
            systeminfo: readSysteminfo(),
            productinfo: readProductinfo(),
            tizen: describeValue(window.tizen, 0, 3),
            webapis: describeValue(window.webapis, 0, 3)
        };

        if (window.Lampa) {
            report.lampa.platform = safe(function () { return window.Lampa.Platform.get(); });
            report.lampa.is_tizen = safe(function () { return window.Lampa.Platform.is('tizen'); });
            report.lampa.is_webos = safe(function () { return window.Lampa.Platform.is('webos'); });
            report.lampa.is_android = safe(function () { return window.Lampa.Platform.is('android'); });
            report.lampa.is_browser = safe(function () { return window.Lampa.Platform.is('browser'); });
        }

        QUICK_CHECKS.forEach(function (path) {
            report.quickChecks[path] = quickCheck(path);
        });

        return report;
    }

    function escapeHtml(s) {
        return String(s).replace(/[<>&"]/g, function (c) {
            return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
        });
    }

    function sendReport(report, cb) {
        var url = reportEndpoint();
        var body = JSON.stringify(report);

        // 1. sendBeacon — менее подвержен CORS preflight
        try {
            if (navigator.sendBeacon) {
                var blob = new Blob([body], { type: 'text/plain' });
                if (navigator.sendBeacon(url, blob)) {
                    cb(null, 'beacon-ok');
                    return;
                }
            }
        } catch (e) {}

        // 2. fetch с text/plain — simple request, без preflight
        try {
            if (window.fetch) {
                fetch(url, {
                    method: 'POST',
                    body: body,
                    headers: { 'Content-Type': 'text/plain' },
                    mode: 'cors'
                }).then(function (r) { cb(null, 'fetch ' + r.status); })
                  .catch(function (e) { fallbackImg(); });
                return;
            }
        } catch (e) {}

        // 3. fallback: <img> ping с минимальным summary в querystring
        fallbackImg();

        function fallbackImg() {
            try {
                var summary = {
                    ts: report.ts,
                    ua: (report.ua || '').slice(0, 100),
                    href: report.href,
                    lampa: report.lampa,
                    qc: {}
                };
                Object.keys(report.quickChecks || {}).forEach(function (k) {
                    summary.qc[k] = report.quickChecks[k].ok ? 1 : 0;
                });
                var qs = encodeURIComponent(JSON.stringify(summary)).slice(0, 6000);
                var img = new Image();
                img.onload = function () { cb(null, 'img-ping'); };
                img.onerror = function () { cb(new Error('all transports failed'), 0); };
                img.src = url.replace(/\/report$/, '/report-img') + '?d=' + qs + '&_=' + Date.now();
            } catch (e) {
                cb(e, 0);
            }
        }
    }

    function startPlugin() {
        var manifest = {
            type: 'video',
            version: PLUGIN_VERSION,
            name: 'Tizen Debug',
            description: 'Дамп tizen / webapis для исследования среды Samsung TV',
            component: 'tizen_debug'
        };

        function Component(object) {
            var scroll = new Lampa.Scroll({ mask: true, over: true });
            var html = $('<div class="tizen-debug"></div>');
            var report;

            this.create = function () {
                report = buildReport();
                console.log('[tizen-debug] report:', report);

                var model = (report.systeminfo && report.systeminfo['http://tizen.org/system/model_name']) || '?';
                var fwBuild = (report.systeminfo && report.systeminfo['http://tizen.org/system/build.string']) || '?';
                var tzVer = (report.systeminfo && report.systeminfo['http://tizen.org/feature/platform.version']) || '?';
                var hasUpnp = report.systeminfo && report.systeminfo['http://tizen.org/feature/network.upnp'];
                var hasDlna = report.systeminfo && report.systeminfo['http://tizen.org/feature/network.dlna'];

                var view = $('<div style="padding:1em 1.5em; font-size:0.9em; line-height:1.35;"></div>');

                view.append('<div style="font-size:1.6em; font-weight:bold; color:#3a73ff; margin-bottom:0.4em;">Tizen Debug v' + PLUGIN_VERSION + '</div>');

                var hdr = $('<div style="margin-bottom:0.8em; padding:0.6em 0.8em; background:rgba(58,115,255,0.18); border-left:4px solid #3a73ff; border-radius:0.3em;"></div>');
                hdr.append('<div style="font-size:1.4em; font-weight:bold;">' + escapeHtml(model) + ' · Tizen ' + escapeHtml(tzVer) + '</div>');
                hdr.append('<div style="font-size:0.85em; opacity:0.8;">build: ' + escapeHtml(fwBuild) + '</div>');
                hdr.append('<div style="font-size:0.85em; opacity:0.8;">network.upnp=' + escapeHtml(String(hasUpnp)) + ' · network.dlna=' + escapeHtml(String(hasDlna)) + '</div>');
                view.append(hdr);

                // hello-ping чтобы лог сервера показал, что новая версия плагина реально запустилась
                try {
                    var helloUrl = (function () {
                        var url = reportEndpoint();
                        return url.replace(/\/report$/, '') + '/ping?from=create&v=' + encodeURIComponent(PLUGIN_VERSION);
                    })();
                    var helloImg = new Image();
                    helloImg.src = helloUrl + '&_=' + Date.now();
                } catch (e) {}

                var btnRefresh = $('<div class="selector" style="display:inline-block; padding:0.5em 1em; background:#444; border-radius:0.3em; margin-bottom:0.6em;">Пересобрать</div>');
                btnRefresh.on('hover:enter', function () {
                    Lampa.Activity.replace({ url: '', title: 'Tizen Debug', component: 'tizen_debug', page: 1 });
                });
                view.append(btnRefresh);

                view.append('<div style="font-size:0.75em; opacity:0.6; margin-bottom:0.6em; word-break:break-all;">' + escapeHtml(report.href) + '</div>');

                view.append('<h3 style="margin:0.6em 0 0.3em 0; color:#ffd966;">Quick checks</h3>');
                Object.keys(report.quickChecks).forEach(function (path) {
                    var qc = report.quickChecks[path];
                    var color = qc.ok ? '#7ed957' : '#ff6464';
                    var mark = qc.ok ? '✓' : '✗';
                    var line = $('<div style="padding:0.25em 0.6em; margin-bottom:0.15em; border-left:3px solid ' + color + '; background:rgba(255,255,255,0.04); font-size:0.95em;"></div>');
                    line.append('<span style="color:' + color + '; font-weight:bold;">' + mark + '</span> <b>' + escapeHtml(path) + '</b>: ' + escapeHtml(qc.summary));
                    if (qc.keys && qc.keys.length) {
                        line.append('<div style="font-size:0.8em; opacity:0.75; margin-top:0.1em; padding-left:1.2em;">' + escapeHtml(qc.keys.join(', ')) + '</div>');
                    }
                    view.append(line);
                });

                // Плоский список верхнеуровневых ключей tizen.* и webapis.* с типами
                view.append('<h3 style="margin:0.8em 0 0.3em 0; color:#ffd966;">tizen.* keys</h3>');
                view.append(flatKeyList(window.tizen));

                view.append('<h3 style="margin:0.8em 0 0.3em 0; color:#ffd966;">webapis.* keys</h3>');
                view.append(flatKeyList(window.webapis));

                view.append('<h3 style="margin:0.8em 0 0.3em 0; color:#ffd966;">productinfo</h3>');
                var piBlock = $('<div style="padding:0.5em 0.7em; background:rgba(255,255,255,0.04); white-space:pre-wrap; font-size:0.8em; word-break:break-all;"></div>');
                piBlock.text(JSON.stringify(report.productinfo, null, 1));
                view.append(piBlock);

                view.append('<h3 style="margin:0.8em 0 0.3em 0; color:#ffd966;">Transport tests (LAN HTTP)</h3>');
                var transportsBox = $('<div></div>');
                view.append(transportsBox);
                runTransportTests(transportsBox);

                scroll.append(view);
                html.append(scroll.render());

                this.activity.loader(false);
                this.activity.toggle();
            };

            function runTransportTests(container) {
                var base = (function () {
                    var url = reportEndpoint();
                    return url.replace(/\/report$/, '');
                })();
                var pingUrl = base + '/ping';

                var tests = [
                    { name: 'fetch GET', run: function (cb) {
                        if (!window.fetch) return cb('NO fetch');
                        fetch(pingUrl).then(function (r) { return r.text().then(function (t) { cb('HTTP ' + r.status + ' · ' + t.slice(0, 80)); }); })
                                      .catch(function (e) { cb('ERR ' + e.message); });
                    }},
                    { name: 'XMLHttpRequest GET', run: function (cb) {
                        try {
                            var x = new XMLHttpRequest();
                            x.open('GET', pingUrl);
                            x.onload = function () { cb('HTTP ' + x.status + ' · ' + (x.responseText || '').slice(0, 80)); };
                            x.onerror = function () { cb('ERR network'); };
                            x.ontimeout = function () { cb('ERR timeout'); };
                            x.timeout = 5000;
                            x.send();
                        } catch (e) { cb('ERR ' + e.message); }
                    }},
                    { name: 'Lampa.Reguest.silent', run: function (cb) {
                        try {
                            if (!Lampa.Reguest) return cb('NO Lampa.Reguest');
                            var r = new Lampa.Reguest();
                            if (typeof r.silent === 'function') {
                                r.silent(pingUrl, function (resp) { cb('OK · ' + String(resp).slice(0, 80)); },
                                                  function (err) { cb('ERR ' + JSON.stringify(err).slice(0, 80)); });
                            } else if (typeof r.native === 'function') {
                                r.native(pingUrl, function (resp) { cb('OK · ' + String(resp).slice(0, 80)); },
                                                  function (err) { cb('ERR ' + JSON.stringify(err).slice(0, 80)); });
                            } else {
                                cb('NO silent/native methods');
                            }
                        } catch (e) { cb('ERR ' + e.message); }
                    }},
                    { name: '<img> ping', run: function (cb) {
                        try {
                            var img = new Image();
                            var done = false;
                            img.onload = function () { if (!done) { done = true; cb('OK loaded'); } };
                            img.onerror = function () { if (!done) { done = true; cb('ERR onerror'); } };
                            setTimeout(function () { if (!done) { done = true; cb('ERR timeout'); } }, 5000);
                            img.src = pingUrl + '?_=' + Date.now();
                        } catch (e) { cb('ERR ' + e.message); }
                    }}
                ];

                tests.forEach(function (t) {
                    var line = $('<div style="padding:0.3em 0.6em; margin-bottom:0.15em; background:rgba(255,255,255,0.04); border-left:3px solid #888;"></div>');
                    line.append('<b>' + escapeHtml(t.name) + '</b>: <span class="result" style="color:#ffd966;">running…</span>');
                    container.append(line);
                    t.run(function (result) {
                        var ok = result.indexOf('HTTP 200') === 0 || result.indexOf('OK') === 0;
                        line.css('border-left-color', ok ? '#7ed957' : '#ff6464');
                        line.find('.result').css('color', ok ? '#7ed957' : '#ff6464').text(result);
                    });
                });
            }

            function flatKeyList(root) {
                var box = $('<div style="font-size:0.85em; line-height:1.3;"></div>');
                if (!root) {
                    box.append('<div style="color:#ff6464;">undefined</div>');
                    return box;
                }
                var keys = [];
                try { keys = Object.getOwnPropertyNames(root); } catch (e) {}
                try { for (var k in root) if (keys.indexOf(k) < 0) keys.push(k); } catch (e) {}
                keys.sort();
                keys.forEach(function (k) {
                    var v;
                    try { v = root[k]; } catch (e) { v = '<error>'; }
                    var t = (v === null) ? 'null' : typeof v;
                    var sub = '';
                    if (t === 'object' && v) {
                        var subKeys = [];
                        try { subKeys = Object.getOwnPropertyNames(v); } catch (e) {}
                        if (subKeys.length) sub = ' { ' + subKeys.slice(0, 30).join(', ') + (subKeys.length > 30 ? ', …' : '') + ' }';
                    }
                    box.append('<div><span style="color:#9bc;">' + escapeHtml(k) + '</span> <span style="opacity:0.6;">' + escapeHtml(t) + '</span><span style="font-size:0.8em; opacity:0.7;">' + escapeHtml(sub) + '</span></div>');
                });
                return box;
            }

            this.render = function () { return html; };

            this.start = function () {
                Lampa.Controller.add('content', {
                    toggle: function () {
                        Lampa.Controller.collectionSet(scroll.render());
                        Lampa.Controller.collectionFocus(false, scroll.render());
                    },
                    up: function () {
                        if (Navigator.canmove('up')) Navigator.move('up');
                        else Lampa.Controller.toggle('head');
                    },
                    down: function () { if (Navigator.canmove('down')) Navigator.move('down'); },
                    left: function () {
                        if (Navigator.canmove('left')) Navigator.move('left');
                        else Lampa.Controller.toggle('menu');
                    },
                    right: function () { if (Navigator.canmove('right')) Navigator.move('right'); },
                    back: function () { Lampa.Activity.backward(); }
                });
                Lampa.Controller.toggle('content');
            };

            this.pause = function () {};
            this.stop = function () {};
            this.destroy = function () {
                scroll.destroy();
                html.remove();
            };
        }

        Lampa.Component.add(manifest.component, Component);

        function addMenu() {
            if ($('.menu .menu__list [data-action="tizen_debug"]').length) return;
            var button = $(
                '<li class="menu__item selector" data-action="tizen_debug">' +
                    '<div class="menu__ico">' +
                        '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg>' +
                    '</div>' +
                    '<div class="menu__text">Tizen Debug</div>' +
                '</li>'
            );
            button.on('hover:enter', function () {
                Lampa.Activity.push({
                    url: '',
                    title: 'Tizen Debug',
                    component: 'tizen_debug',
                    page: 1
                });
            });
            $('.menu .menu__list').eq(0).append(button);
        }

        if (window.appready) addMenu();
        else Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') addMenu();
        });

        Lampa.Manifest.plugins = manifest;
    }

    if (!window.plugin_tizen_debug) {
        window.plugin_tizen_debug = true;
        startPlugin();
    }
})();
