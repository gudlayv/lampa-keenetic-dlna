(function () {
    'use strict';

    if (window.plugin_keenetic_dlna) return;
    window.plugin_keenetic_dlna = true;

    var PLUGIN_VERSION = '0.1.1';

    // Хардкодим — упрощаем MVP. Позже вынесем в Lampa.SettingsApi.
    var PROXY_BASE = 'https://shakespeare-eden-composition-aluminum.trycloudflare.com/proxy/';
    var DLNA_BASE = 'http://192.168.1.1:8200';
    var CONTROL_URL = DLNA_BASE + '/ctl/ContentDir';
    var SOAPNS = 'urn:schemas-upnp-org:service:ContentDirectory:1';

    function escapeHtml(s) {
        return String(s).replace(/[<>&"]/g, function (c) {
            return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
        });
    }

    function browse(objectId, success, error) {
        var soapBody =
            '<?xml version="1.0"?>\n' +
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
            '<s:Body><u:Browse xmlns:u="' + SOAPNS + '">' +
            '<ObjectID>' + escapeHtml(objectId) + '</ObjectID>' +
            '<BrowseFlag>BrowseDirectChildren</BrowseFlag>' +
            '<Filter>*</Filter>' +
            '<StartingIndex>0</StartingIndex>' +
            '<RequestedCount>1000</RequestedCount>' +
            '<SortCriteria></SortCriteria>' +
            '</u:Browse></s:Body></s:Envelope>';

        $.ajax({
            url: PROXY_BASE + CONTROL_URL,
            type: 'POST',
            dataType: 'xml',
            data: soapBody,
            timeout: 15000,
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SOAPAction': '"' + SOAPNS + '#Browse"'
            },
            success: function (xml) {
                try { success(parseBrowseResponse(xml)); }
                catch (e) { error({ message: 'parse: ' + e.message }); }
            },
            error: function (xhr, status, err) {
                error({ status: xhr && xhr.status, statusText: status, err: String(err), body: (xhr && xhr.responseText || '').slice(0, 200) });
            }
        });
    }

    function parseBrowseResponse(xmlDoc) {
        var resultEl = xmlDoc.getElementsByTagName('Result')[0];
        if (!resultEl) throw new Error('no <Result>');
        var didlXmlText = resultEl.textContent;
        var didl = new DOMParser().parseFromString(didlXmlText, 'text/xml');
        var entries = [];
        var containers = didl.getElementsByTagName('container');
        for (var i = 0; i < containers.length; i++) entries.push(parseNode(containers[i], 'container'));
        var items = didl.getElementsByTagName('item');
        for (var i = 0; i < items.length; i++) entries.push(parseNode(items[i], 'item'));
        return entries;
    }

    function parseNode(node, kind) {
        var info = { kind: kind };
        info.id = node.getAttribute('id');
        info.parentID = node.getAttribute('parentID');
        var title = node.getElementsByTagName('dc:title')[0] || node.getElementsByTagName('title')[0];
        info.title = title ? title.textContent : '(no title)';
        var cls = node.getElementsByTagName('upnp:class')[0] || node.getElementsByTagName('class')[0];
        info.upnpClass = cls ? cls.textContent : '';
        info.isFolder = info.upnpClass.indexOf('object.container') === 0;
        var res = node.getElementsByTagName('res')[0];
        if (res) {
            info.url = res.textContent;
            info.size = res.getAttribute('size');
            info.duration = res.getAttribute('duration');
            info.resolution = res.getAttribute('resolution');
            info.protocolInfo = res.getAttribute('protocolInfo');
        }
        return info;
    }

    function formatSize(bytes) {
        var n = Number(bytes);
        if (!n) return '';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
    }

    function Component() {
        var stack = [{ id: '0', title: 'Keenetic Ultra' }];
        var html, scroll, self = this;

        this.create = function () {
            html = $('<div class="dlna-keenetic"></div>');
            scroll = new Lampa.Scroll({ mask: true, over: true });
            html.append(scroll.render());
            this.activity.loader(true);
            this.openCurrent();
        };

        this.openCurrent = function () {
            var top = stack[stack.length - 1];
            scroll.clear();

            var pathRow = $('<div style="padding:0.8em 1.2em; font-size:0.9em; opacity:0.7; word-break:break-all;"></div>');
            pathRow.text(stack.map(function (s) { return s.title; }).join(' / '));
            scroll.append(pathRow);
            scroll.append($('<div style="padding:1em 1.2em;">Загрузка ' + escapeHtml(top.title) + '…</div>'));

            browse(top.id, function (entries) {
                scroll.clear();
                scroll.append(pathRow);

                if (stack.length > 1) {
                    var backBtn = $('<div class="selector" style="margin:0.4em 1em; padding:0.7em 1em; background:rgba(58,115,255,0.15); border-radius:0.5em;">⮜ Назад</div>');
                    backBtn.on('hover:enter', function () { stack.pop(); self.openCurrent(); });
                    scroll.append(backBtn);
                }

                if (!entries.length) {
                    scroll.append($('<div style="padding:1.5em; opacity:0.6;">Папка пуста</div>'));
                }

                entries.forEach(function (entry) {
                    var line = $('<div class="selector" style="margin:0.3em 1em; padding:0.8em 1em; background:rgba(255,255,255,0.06); border-radius:0.5em;"></div>');
                    var icon = entry.isFolder ? '📁' : '🎬';
                    line.append('<div><b>' + icon + ' ' + escapeHtml(entry.title) + '</b></div>');
                    var meta = [];
                    if (entry.resolution) meta.push(entry.resolution);
                    if (entry.duration) meta.push(entry.duration);
                    if (entry.size) meta.push(formatSize(entry.size));
                    if (meta.length) {
                        line.append('<div style="font-size:0.8em; opacity:0.65; margin-top:0.2em;">' + escapeHtml(meta.join(' · ')) + '</div>');
                    }
                    line.on('hover:enter', function () {
                        if (entry.isFolder) {
                            stack.push({ id: entry.id, title: entry.title });
                            self.openCurrent();
                        } else if (entry.url) {
                            Lampa.Player.play({ title: entry.title, url: entry.url });
                            Lampa.Player.playlist([{ title: entry.title, url: entry.url }]);
                        } else {
                            Lampa.Noty.show('Нет URL для воспроизведения');
                        }
                    });
                    line.on('hover:focus', function () { scroll.update(line); });
                    scroll.append(line);
                });

                self.activity.loader(false);
                self.activity.toggle();
                // Пересобрать collection после добавления selectors и сразу выставить фокус
                Lampa.Controller.toggle('content');
            }, function (err) {
                scroll.clear();
                scroll.append(pathRow);
                var box = $('<div style="margin:1em; padding:1em; background:rgba(255,100,100,0.15); border-left:4px solid #ff6464; border-radius:0.4em; font-size:0.9em; word-break:break-all;"></div>');
                box.append('<b>Ошибка Browse:</b><br>' + escapeHtml(JSON.stringify(err)));
                scroll.append(box);
                self.activity.loader(false);
            });
        };

        this.render = function () { return html; };

        this.start = function () {
            if (Lampa.Activity.active() && Lampa.Activity.active().activity !== this.activity) return;
            Lampa.Controller.add('content', {
                invisible: true,
                toggle: function () {
                    Lampa.Controller.collectionSet(html);
                    Lampa.Controller.collectionFocus(false, html);
                },
                up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('head'); },
                down: function () { if (Navigator.canmove('down')) Navigator.move('down'); },
                left: function () { if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
                right: function () { if (Navigator.canmove('right')) Navigator.move('right'); },
                back: function () {
                    if (stack.length > 1) { stack.pop(); self.openCurrent(); }
                    else Lampa.Activity.backward();
                }
            });
            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            if (scroll) scroll.destroy();
            if (html) html.remove();
        };
    }

    function startPlugin() {
        var manifest = {
            type: 'video',
            version: PLUGIN_VERSION,
            name: 'Keenetic DLNA',
            description: 'DLNA-клиент для Keenetic Ultra (MiniDLNA)',
            component: 'keenetic_dlna'
        };

        Lampa.Component.add(manifest.component, Component);

        function addMenu() {
            if ($('.menu .menu__list [data-action="keenetic_dlna"]').length) return;
            var button = $(
                '<li class="menu__item selector" data-action="keenetic_dlna">' +
                    '<div class="menu__ico">' +
                        '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                            '<rect x="2" y="6" width="20" height="12" rx="2"/>' +
                            '<polygon points="10 9 16 12 10 15" fill="currentColor"/>' +
                        '</svg>' +
                    '</div>' +
                    '<div class="menu__text">Keenetic DLNA</div>' +
                '</li>'
            );
            button.on('hover:enter', function () {
                Lampa.Activity.push({
                    url: '',
                    title: 'Keenetic DLNA',
                    component: 'keenetic_dlna',
                    page: 1
                });
            });
            $('.menu .menu__list').eq(0).append(button);
        }

        if (window.appready) addMenu();
        else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') addMenu(); });

        Lampa.Manifest.plugins = manifest;
    }

    startPlugin();
})();
