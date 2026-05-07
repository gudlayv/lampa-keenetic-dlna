(function () {
    'use strict';

    var PLUGIN_VERSION = '0.1.0';
    var REPORT_ENDPOINT_KEY = 'tizen_debug_report_url';
    var REPORT_ENDPOINT_DEFAULT = 'http://192.168.1.129:8080/report';

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
        'webapis.allshare',
        'webapis.allshare.serviceconnector',
        'webapis.network',
        'webapis.avplay',
        'webapis.avinfo',
        'webapis.productinfo',
        'webapis.tvinfo',
        'webapis.tvchannel',
        'webapis.tvinputdevice',
        'webapis.appcommon',
        'webapis.preview',
        'tizen',
        'tizen.systeminfo',
        'tizen.network',
        'tizen.application',
        'tizen.filesystem',
        'tizen.tvchannel',
        'tizen.tvinputdevice',
        'tizen.tvwindow',
        'tizen.power',
        'tizen.SocketAddress'
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
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onload = function () { cb(null, xhr.status); };
            xhr.onerror = function () { cb(new Error('network error'), 0); };
            xhr.ontimeout = function () { cb(new Error('timeout'), 0); };
            xhr.timeout = 10000;
            xhr.send(JSON.stringify(report));
        } catch (e) {
            cb(e, 0);
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

                var view = $('<div style="padding:1.5em; font-size:1em; line-height:1.4;"></div>');
                view.append('<h2 style="margin-bottom:1em;">Tizen Debug v' + PLUGIN_VERSION + '</h2>');

                var summary = $('<div style="margin-bottom:1em; font-size:0.9em; opacity:0.8;"></div>');
                summary.append('<div><b>UA:</b> ' + escapeHtml(report.ua) + '</div>');
                summary.append('<div><b>Time:</b> ' + report.ts + '</div>');
                summary.append('<div><b>Lampa platform:</b> ' + escapeHtml(JSON.stringify(report.lampa)) + '</div>');
                view.append(summary);

                var btnRow = $('<div style="margin:1em 0;"></div>');

                var btnSend = $('<div class="selector" style="display:inline-block; padding:0.7em 1.2em; margin-right:0.7em; background:#3a73ff; border-radius:0.4em;">Отправить отчет</div>');
                btnSend.on('hover:enter', function () {
                    Lampa.Noty.show('Отправляю отчет на ' + reportEndpoint());
                    sendReport(report, function (err, status) {
                        if (err) Lampa.Noty.show('Ошибка: ' + err.message);
                        else Lampa.Noty.show('Отправлено: HTTP ' + status);
                    });
                });
                btnRow.append(btnSend);

                var btnLog = $('<div class="selector" style="display:inline-block; padding:0.7em 1.2em; margin-right:0.7em; background:#444; border-radius:0.4em;">Console.log</div>');
                btnLog.on('hover:enter', function () {
                    console.log('[tizen-debug] full report:', report);
                    Lampa.Noty.show('Отчет в консоли (Web Inspector)');
                });
                btnRow.append(btnLog);

                var btnRefresh = $('<div class="selector" style="display:inline-block; padding:0.7em 1.2em; background:#444; border-radius:0.4em;">Пересобрать</div>');
                btnRefresh.on('hover:enter', function () {
                    Lampa.Activity.replace({
                        url: '', title: 'Tizen Debug', component: 'tizen_debug', page: 1
                    });
                });
                btnRow.append(btnRefresh);

                view.append(btnRow);

                view.append('<h3 style="margin-top:1.2em; margin-bottom:0.5em;">Quick checks</h3>');
                Object.keys(report.quickChecks).forEach(function (path) {
                    var qc = report.quickChecks[path];
                    var color = qc.ok ? '#7ed957' : '#ff6464';
                    var line = $('<div class="selector" style="padding:0.4em 0.8em; margin-bottom:0.2em; border-left:3px solid ' + color + '; background:rgba(255,255,255,0.04);"></div>');
                    line.append('<b>' + escapeHtml(path) + '</b>: ' + escapeHtml(qc.summary));
                    if (qc.keys && qc.keys.length) {
                        line.append('<div style="font-size:0.8em; opacity:0.7; margin-top:0.2em;">' + escapeHtml(qc.keys.join(', ')) + '</div>');
                    }
                    view.append(line);
                });

                view.append('<h3 style="margin-top:1.2em; margin-bottom:0.5em;">tizen.systeminfo capabilities</h3>');
                var siBlock = $('<div class="selector" style="padding:0.7em; background:rgba(255,255,255,0.04); white-space:pre-wrap; font-size:0.8em;"></div>');
                siBlock.text(JSON.stringify(report.systeminfo, null, 2));
                view.append(siBlock);

                view.append('<h3 style="margin-top:1.2em; margin-bottom:0.5em;">webapis.productinfo</h3>');
                var piBlock = $('<div class="selector" style="padding:0.7em; background:rgba(255,255,255,0.04); white-space:pre-wrap; font-size:0.8em;"></div>');
                piBlock.text(JSON.stringify(report.productinfo, null, 2));
                view.append(piBlock);

                view.append('<h3 style="margin-top:1.2em; margin-bottom:0.5em;">tizen (depth 3)</h3>');
                var tzBlock = $('<div class="selector" style="padding:0.7em; background:rgba(255,255,255,0.04); white-space:pre-wrap; font-size:0.75em; max-height:30em; overflow:hidden;"></div>');
                tzBlock.text(JSON.stringify(report.tizen, null, 2));
                view.append(tzBlock);

                view.append('<h3 style="margin-top:1.2em; margin-bottom:0.5em;">webapis (depth 3)</h3>');
                var waBlock = $('<div class="selector" style="padding:0.7em; background:rgba(255,255,255,0.04); white-space:pre-wrap; font-size:0.75em; max-height:30em; overflow:hidden;"></div>');
                waBlock.text(JSON.stringify(report.webapis, null, 2));
                view.append(waBlock);

                this.activity.loader(false);
                this.activity.toggle();

                scroll.append(view);
                html.append(scroll.render());
            };

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
