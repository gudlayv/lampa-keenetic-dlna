(function () {
    'use strict';

    if (window.plugin_keenetic_dlna) return;
    window.plugin_keenetic_dlna = true;

    var PLUGIN_VERSION = '0.2.0';

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

    var ICON_BACK =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.2em;margin-right:0.4em;">' +
            '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>' +
        '</svg>';

    var ICON_FOLDER =
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-0.3em;margin-right:0.5em;">' +
            '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/>' +
        '</svg>';

    var ICON_VIDEO =
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.3em;margin-right:0.5em;">' +
            '<polygon points="23 7 16 12 23 17 23 7"/>' +
            '<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' +
        '</svg>';

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

    // Парсим имя файла: пробуем выделить чистое название и год
    // "Wake.Up.Dead.Man.A.Knives.Out.Mystery.2025.2160p_RHS" → {title: "Wake Up Dead Man A Knives Out Mystery", year: 2025}
    function parseFilename(name) {
        // убираем расширение если есть
        name = name.replace(/\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i, '');
        var yearMatch = name.match(/[._\s\-(](19|20)\d{2}[._\s\-)]/);
        if (yearMatch) {
            var idx = yearMatch.index;
            var year = parseInt(name.substr(idx + 1, 4), 10);
            var title = name.substring(0, idx).replace(/[._]+/g, ' ').trim();
            return { title: title, year: year };
        }
        return { title: name.replace(/[._]+/g, ' ').trim(), year: null };
    }

    // TMDB search через API ключ LAMPA
    var tmdbCache = {};
    function tmdbSearch(title, year, cb) {
        var key = title + '|' + (year || '');
        if (tmdbCache[key]) { cb(tmdbCache[key]); return; }
        if (!window.Lampa || !Lampa.TMDB) { cb(null); return; }
        var url = Lampa.TMDB.api('search/movie?api_key=' + Lampa.TMDB.key() +
            '&language=ru&query=' + encodeURIComponent(title) +
            (year ? '&year=' + year : '') +
            '&include_adult=false');
        var network = new Lampa.Reguest();
        network.timeout(10000);
        network.silent(url, function (data) {
            var hit = (data && data.results && data.results[0]) || null;
            tmdbCache[key] = hit;
            cb(hit);
        }, function () { cb(null); });
    }

    function tmdbPosterUrl(posterPath, size) {
        if (!posterPath || !window.Lampa || !Lampa.TMDB) return '';
        return Lampa.TMDB.image('t/p/' + (size || 'w200') + posterPath);
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
                    var backBtn = $('<div class="selector" style="margin:0.4em 1em; padding:0.7em 1em; background:rgba(58,115,255,0.15); border-radius:0.5em;">' + ICON_BACK + 'Назад</div>');
                    backBtn.on('hover:enter', function () { stack.pop(); self.openCurrent(); });
                    backBtn.on('hover:focus', function () { scroll.update(backBtn); });
                    scroll.append(backBtn);
                }

                if (!entries.length) {
                    scroll.append($('<div style="padding:1.5em; opacity:0.6;">Папка пуста</div>'));
                }

                entries.forEach(function (entry) {
                    var line;
                    if (entry.isFolder) {
                        line = $('<div class="selector dlna-row dlna-row--folder" style="margin:0.3em 1em; padding:0.8em 1em; background:rgba(255,255,255,0.06); border-radius:0.5em;"></div>');
                        line.append('<div><b>' + ICON_FOLDER + escapeHtml(entry.title) + '</b></div>');
                    } else {
                        // Видео — раскладка с местом под постер
                        line = $('<div class="selector dlna-row dlna-row--video" style="margin:0.3em 1em; padding:0.6em 1em; background:rgba(255,255,255,0.06); border-radius:0.5em; display:flex; align-items:center; gap:0.9em;"></div>');
                        var poster = $('<div class="dlna-row__poster" style="flex:0 0 auto; width:4.5em; height:6.5em; border-radius:0.3em; background:rgba(255,255,255,0.08) center/cover no-repeat; display:flex; align-items:center; justify-content:center;"></div>');
                        poster.html('<div style="opacity:0.4;">' + ICON_VIDEO + '</div>');
                        line.append(poster);

                        var info = $('<div class="dlna-row__info" style="flex:1 1 auto; min-width:0;"></div>');
                        info.append('<div class="dlna-row__title" style="font-weight:600; font-size:1.05em; word-break:break-word;">' + escapeHtml(entry.title) + '</div>');
                        var localMeta = [];
                        if (entry.resolution) localMeta.push(entry.resolution);
                        if (entry.duration) localMeta.push(entry.duration);
                        if (entry.size) localMeta.push(formatSize(entry.size));
                        if (localMeta.length) {
                            info.append('<div class="dlna-row__local" style="font-size:0.78em; opacity:0.6; margin-top:0.2em;">' + escapeHtml(localMeta.join(' · ')) + '</div>');
                        }
                        info.append('<div class="dlna-row__tmdb" style="font-size:0.82em; opacity:0.85; margin-top:0.3em; color:#ffd966;">ищу в TMDB…</div>');
                        line.append(info);

                        // Async TMDB enrichment
                        var parsed = parseFilename(entry.title);
                        tmdbSearch(parsed.title, parsed.year, function (hit) {
                            var box = info.find('.dlna-row__tmdb');
                            if (!hit) {
                                box.text(parsed.year ? ('TMDB: не найдено · ' + parsed.title + ' (' + parsed.year + ')') : 'TMDB: не найдено').css('color', '#888');
                                return;
                            }
                            // Заменяем заголовок на TMDB-название
                            var tmdbTitle = hit.title || hit.original_title || parsed.title;
                            var year = (hit.release_date || '').slice(0, 4);
                            info.find('.dlna-row__title').text(tmdbTitle + (year ? ' (' + year + ')' : ''));
                            // Метаданные
                            var rating = hit.vote_average ? '★ ' + hit.vote_average.toFixed(1) : '';
                            var orig = (hit.original_title && hit.original_title !== tmdbTitle) ? hit.original_title : '';
                            var bits = [];
                            if (rating) bits.push('<span style="color:#ffd966;">' + rating + '</span>');
                            if (orig) bits.push('<span style="opacity:0.7;">' + escapeHtml(orig) + '</span>');
                            box.html(bits.join(' · ') || '');
                            // Постер
                            if (hit.poster_path) {
                                var url = tmdbPosterUrl(hit.poster_path, 'w200');
                                poster.css({
                                    'background-image': 'url("' + url + '")',
                                    'background-size': 'cover',
                                    'background-position': 'center'
                                });
                                poster.empty();
                            }
                            // Описание добавим под мета
                            if (hit.overview) {
                                if (info.find('.dlna-row__overview').length === 0) {
                                    info.append('<div class="dlna-row__overview" style="font-size:0.78em; opacity:0.7; margin-top:0.3em; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;"></div>');
                                }
                                info.find('.dlna-row__overview').text(hit.overview);
                            }
                            // Сохраним для последующих этапов (history/full-card)
                            entry.tmdb = hit;
                        });
                    }
                    line.on('hover:enter', function () {
                        if (entry.isFolder) {
                            stack.push({ id: entry.id, title: entry.title });
                            self.openCurrent();
                        } else if (entry.url) {
                            var title = (entry.tmdb && entry.tmdb.title) || entry.title;
                            Lampa.Player.play({ title: title, url: entry.url });
                            Lampa.Player.playlist([{ title: title, url: entry.url }]);
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

    function injectStyles() {
        if (document.getElementById('keenetic-dlna-styles')) return;
        var style = document.createElement('style');
        style.id = 'keenetic-dlna-styles';
        style.textContent =
            '.dlna-keenetic .selector{transition:transform 0.12s ease,background-color 0.12s ease;position:relative;}' +
            '.dlna-keenetic .selector.focus,' +
            '.dlna-keenetic .selector.hover{background:#fff!important;color:#000!important;transform:scale(1.015);}' +
            '.dlna-keenetic .selector.focus *,' +
            '.dlna-keenetic .selector.hover *{color:#000!important;}' +
            '.dlna-keenetic .selector.focus::after{content:"";position:absolute;inset:-0.4em;border:0.25em solid #ffd966;border-radius:0.7em;pointer-events:none;}';
        document.head.appendChild(style);
    }

    function startPlugin() {
        injectStyles();

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
