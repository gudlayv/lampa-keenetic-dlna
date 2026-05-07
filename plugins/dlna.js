(function () {
    'use strict';

    if (window.plugin_keenetic_dlna) return;
    window.plugin_keenetic_dlna = true;

    var PLUGIN_VERSION = '0.5.4';

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
        var dateEl = node.getElementsByTagName('dc:date')[0];
        info.date = dateEl ? dateEl.textContent : '';
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
    function parseFilename(name) {
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

    // Парсим эпизод: SxxExx или 1x03. Возвращает {show, season, episode} или null.
    function parseEpisode(name) {
        name = name.replace(/\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i, '');
        var m = name.match(/^(.+?)[._\s\-]+S(\d{1,2})[._\s\-]?E(\d{1,3})/i);
        if (m) {
            return { show: m[1].replace(/[._]+/g, ' ').trim(), season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
        }
        m = name.match(/^(.+?)[._\s\-]+(\d{1,2})x(\d{1,3})\b/i);
        if (m) {
            return { show: m[1].replace(/[._]+/g, ' ').trim(), season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
        }
        return null;
    }

    // TMDB search через API ключ LAMPA. type: 'movie' | 'tv'
    var tmdbCache = {};
    function tmdbSearch(title, year, type, cb) {
        if (typeof type === 'function') { cb = type; type = 'movie'; }
        type = type || 'movie';
        var key = type + '|' + title + '|' + (year || '');
        if (tmdbCache[key]) { cb(tmdbCache[key]); return; }
        if (!window.Lampa || !Lampa.TMDB) { cb(null); return; }
        var qParam = type === 'tv' ? '&first_air_date_year=' : '&year=';
        var url = Lampa.TMDB.api('search/' + type + '?api_key=' + Lampa.TMDB.key() +
            '&language=ru&query=' + encodeURIComponent(title) +
            (year ? qParam + year : '') +
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

    // Получить мету сезона: episodes с name, overview, still_path, vote_average
    var tmdbSeasonCache = {};
    function tmdbSeason(seriesId, seasonNumber, cb) {
        var key = seriesId + ':s' + seasonNumber;
        if (tmdbSeasonCache[key]) { cb(tmdbSeasonCache[key]); return; }
        var url = Lampa.TMDB.api('tv/' + seriesId + '/season/' + seasonNumber + '?api_key=' + Lampa.TMDB.key() + '&language=ru');
        var network = new Lampa.Reguest();
        network.timeout(10000);
        network.silent(url, function (data) {
            tmdbSeasonCache[key] = data;
            cb(data);
        }, function () { cb(null); });
    }

    // Стабильный хеш для DLNA-файла (по URL) — fallback когда нет TMDB hit
    function fileHash(url) {
        if (window.Lampa && Lampa.Utils && typeof Lampa.Utils.hash === 'function') {
            return 'dlna_' + Lampa.Utils.hash(url);
        }
        // Fallback djb2
        var h = 5381;
        for (var i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
        return 'dlna_' + (h >>> 0).toString(36);
    }

    // Hash в формате LAMPA: используется на main TMDB-карточке для отображения прогресса.
    // Фильм:    Utils.hash(original_title)
    // Эпизод:   Utils.hash(season + (season>10?':':'') + episode + original_name)
    function lampaHash(card, season, episode) {
        if (!card || !window.Lampa || !Lampa.Utils) return null;
        var orig = card.original_name || card.original_title;
        if (!orig) return null;
        if (season != null && episode != null) {
            return Lampa.Utils.hash([season, season > 10 ? ':' : '', episode, orig].join(''));
        }
        return Lampa.Utils.hash(orig);
    }

    // Длительность строки "2:26:15.680" → секунды
    function parseDurationToSeconds(s) {
        if (!s) return 0;
        var m = String(s).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (!m) return 0;
        return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    }

    // Сборка card-объекта для Favorite/Player
    function buildCard(entry, hash) {
        var fallbackId = hash;
        if (entry.tmdb && entry.tmdb.id) {
            return Object.assign({}, entry.tmdb, {
                source: 'tmdb',
                method: 'movie'
            });
        }
        return {
            id: fallbackId,
            source: 'dlna',
            method: 'movie',
            title: entry.title,
            original_title: entry.title,
            release_date: '',
            vote_average: 0,
            poster_path: '',
            overview: ''
        };
    }

    // Группируем серии в виртуальные папки. На вход — DLNA-entries.
    // Возвращает entries с виртуальными папками вместо отдельных серий.
    function groupEpisodes(rawEntries) {
        var groups = {};
        var rest = [];
        rawEntries.forEach(function (e) {
            if (e.isFolder) { rest.push(e); return; }
            var ep = parseEpisode(e.title);
            if (!ep) { rest.push(e); return; }
            var key = ep.show.toLowerCase() + '|' + ep.season;
            if (!groups[key]) groups[key] = { show: ep.show, season: ep.season, episodes: [] };
            e._episode = ep;
            groups[key].episodes.push(e);
        });
        var groupKeys = Object.keys(groups);
        if (!groupKeys.length) return rest;

        var virtual = groupKeys.map(function (k) {
            var g = groups[k];
            g.episodes.sort(function (a, b) { return a._episode.episode - b._episode.episode; });
            return {
                isFolder: true,
                isVirtualSeries: true,
                title: g.show + ' · Сезон ' + g.season + ' · ' + g.episodes.length + ' сер.',
                show: g.show,
                season: g.season,
                episodes: g.episodes,
                upnpClass: 'object.container.storageFolder.virtual'
            };
        });
        return virtual.concat(rest);
    }

    // Резолв Object ID для "All Video" в MiniDLNA-индексе.
    // Корень → ищем "Video" → внутри ищем "All Video" → его id.
    // Кешируем в Lampa.Storage 'dlna_all_video_id', сбрасываем по ручке.
    var ALL_VIDEO_ID_KEY = 'dlna_all_video_id';
    function findAllVideoId(cb) {
        try {
            var cached = Lampa.Storage.get(ALL_VIDEO_ID_KEY, '');
            if (cached) { cb(cached); return; }
        } catch (e) {}
        browse('0', function (rootEntries) {
            var videoFolder = rootEntries.find(function (e) {
                return e.isFolder && /^video$/i.test(e.title);
            });
            if (!videoFolder) { cb(null); return; }
            browse(videoFolder.id, function (videoEntries) {
                var allVideo = videoEntries.find(function (e) {
                    return e.isFolder && /^all\s*video$/i.test(e.title);
                });
                if (!allVideo) { cb(null); return; }
                try { Lampa.Storage.set(ALL_VIDEO_ID_KEY, allVideo.id); } catch (e) {}
                cb(allVideo.id);
            }, function () { cb(null); });
        }, function () { cb(null); });
    }

    var TABS = [
        { id: 'all',     title: 'Все' },
        { id: 'movies',  title: 'Фильмы' },
        { id: 'series',  title: 'Сериалы' },
        { id: 'folders', title: 'Папки' }
    ];

    function Component() {
        var currentTab = 'all';
        // Стек на каждую вкладку — позволяет сохранить позицию при переключении
        var stacks = {
            all:     [{ kind: 'all',     title: 'Все видео' }],
            movies:  [{ kind: 'movies',  title: 'Фильмы' }],
            series:  [{ kind: 'series',  title: 'Сериалы' }],
            folders: [{ id: '0',         title: 'Keenetic Ultra' }]
        };
        var html, head, tabsRow, body, scroll, self = this;

        this.create = function () {
            html = $('<div class="dlna-keenetic"></div>');
            head = $('<div class="dlna-keenetic__head"></div>');
            body = $('<div class="dlna-keenetic__body"></div>');
            scroll = new Lampa.Scroll({ mask: true, over: true });
            scroll.minus(head);
            body.append(scroll.render(true));
            html.append(head).append(body);
            renderTabs();
            this.activity.loader(true);
            this.openCurrent();
        };

        function getStack() { return stacks[currentTab]; }

        function setHead() {
            head.empty();
            // Хлебные крошки только для вкладок где пользователь "погружён":
            // Папки — DLNA-путь; Сериалы внутри сезона — путь сериала.
            var stack = getStack();
            if (stack.length > 1) {
                var pathRow = $('<div class="dlna-keenetic__head-path"></div>');
                pathRow.text(stack.map(function (s) { return s.title; }).join(' / '));
                head.append(pathRow);
            }
            head.append(tabsRow);
        }

        function renderTabs() {
            tabsRow = $('<div class="dlna-keenetic__tabs"></div>');
            TABS.forEach(function (t) {
                var btn = $('<div class="selector dlna-keenetic__tab" data-tab="' + t.id + '">' + escapeHtml(t.title) + '</div>');
                if (t.id === currentTab) btn.addClass('dlna-keenetic__tab--active');
                btn.on('hover:enter', function () { switchTab(t.id); });
                btn.on('hover:focus', function () { /* tabs всегда видны, scroll не нужен */ });
                tabsRow.append(btn);
            });
        }

        function switchTab(tabId) {
            if (tabId === currentTab) return;
            currentTab = tabId;
            tabsRow.find('.dlna-keenetic__tab').removeClass('dlna-keenetic__tab--active');
            tabsRow.find('[data-tab="' + tabId + '"]').addClass('dlna-keenetic__tab--active');
            // Сразу перевешиваем фокус на новый active tab — не полагаемся на toggle handler
            // (он no-op если controller уже активен, фокус оставался на прежнем tab).
            var activeTab = tabsRow.find('.dlna-keenetic__tab--active')[0];
            if (activeTab) {
                Lampa.Controller.collectionSet(tabsRow);
                Lampa.Controller.collectionFocus(activeTab, tabsRow);
            }
            self.openCurrent({ keepFocusOnTab: true });
        }

        this.openCurrent = function (opts) {
            opts = opts || {};
            var stack = getStack();
            var top = stack[stack.length - 1];
            setHead();
            scroll.clear();
            scroll.append($('<div style="padding:1em 1.2em; opacity:0.7;">Загрузка…</div>'));

            // Виртуальная группа эпизодов сериала — payload в стеке
            if (top.kind === 'episodes') {
                var payload = top.payload || [];
                var seriesTmdb = payload[0] && payload[0]._series && payload[0]._series.tmdb;
                if (seriesTmdb && seriesTmdb.id != null) {
                    tmdbSeason(seriesTmdb.id, payload[0]._episode.season, function (seasonData) {
                        if (seasonData && seasonData.episodes) {
                            var byNum = {};
                            seasonData.episodes.forEach(function (e) { byNum[e.episode_number] = e; });
                            payload.forEach(function (entry) {
                                if (entry._episode && byNum[entry._episode.episode]) entry._tmdbEpisode = byNum[entry._episode.episode];
                            });
                        }
                        renderEntries(payload, opts);
                    });
                } else {
                    renderEntries(payload, opts);
                }
                return;
            }

            // "Папки" — Browse по DLNA-id из стека
            if (currentTab === 'folders') {
                browse(top.id, function (entries) { renderEntries(entries, opts); }, browseError);
                return;
            }

            // "Все/Фильмы/Сериалы" — единый источник: All Video из MiniDLNA
            findAllVideoId(function (allVideoId) {
                if (!allVideoId) {
                    scroll.clear();
                    scroll.append($('<div style="padding:1.5em; color:#ff6464;">Не нашёл папку «All Video» в DLNA-индексе. Перейди на вкладку «Папки» — там навигация по реальной структуре.</div>'));
                    self.activity.loader(false);
                    return;
                }
                browse(allVideoId, function (entries) {
                    entries.sort(function (a, b) {
                        var da = a.date || '', db = b.date || '';
                        return db.localeCompare(da);
                    });
                    if (currentTab === 'movies') {
                        entries = entries.filter(function (e) { return !e.isFolder && !parseEpisode(e.title); });
                    } else if (currentTab === 'series') {
                        entries = entries.filter(function (e) { return !e.isFolder && parseEpisode(e.title); });
                    }
                    renderEntries(entries, opts);
                }, browseError);
            });
        };

        function browseError(err) {
            scroll.clear();
            var box = $('<div style="margin:1em; padding:1em; background:rgba(255,100,100,0.15); border-left:4px solid #ff6464; border-radius:0.4em; font-size:0.9em; word-break:break-all;"></div>');
            box.append('<b>Ошибка Browse:</b><br>' + escapeHtml(JSON.stringify(err)));
            scroll.append(box);
            self.activity.loader(false);
        }

        function renderEntries(rawEntries, opts) {
            opts = opts || {};
            scroll.clear();

            var stack = getStack();
            if (stack.length > 1) {
                var backBtn = $('<div class="selector" style="margin:0.4em 1em; padding:0.7em 1em; background:rgba(58,115,255,0.15); border-radius:0.5em;">' + ICON_BACK + 'Назад</div>');
                backBtn.on('hover:enter', function () { stack.pop(); self.openCurrent(); });
                backBtn.on('hover:focus', function () { scroll.update(backBtn); });
                scroll.append(backBtn);
            }

            // Внутри виртуальной папки серии уже разобраны — повторная группировка
            // снова свернет их в одну "Сезон 1 · 1 сер." → бесконечная вложенность.
            // Также пропускаем группировку на вкладке "movies" (там уже фильтр без серий).
            var top = stack[stack.length - 1];
            var skipGroup = top.kind === 'episodes' || currentTab === 'movies';
            var entries = skipGroup ? rawEntries : groupEpisodes(rawEntries);

            if (!entries.length) {
                scroll.append($('<div style="padding:1.5em; opacity:0.6;">Папка пуста</div>'));
            }

            entries.forEach(function (entry) {
                var line = renderEntryRow(entry);
                line.on('hover:focus', function () { scroll.update(line); });
                scroll.append(line);
            });

            self.activity.loader(false);
            self.activity.toggle();
            // Если переключаемся между вкладками — фокус уже стоит на active tab
            // (поставлен в switchTab), ничего не трогаем.
            if (!opts.keepFocusOnTab) {
                Lampa.Controller.toggle('content');
            }
        }

        function renderEntryRow(entry) {
            if (entry.isFolder) {
                if (entry.isVirtualSeries) {
                    return renderSeriesRow(entry);
                }
                var line = $('<div class="selector dlna-row dlna-row--folder" style="margin:0.3em 1em; padding:0.8em 1em; background:rgba(255,255,255,0.06); border-radius:0.5em;"></div>');
                line.append('<div><b>' + ICON_FOLDER + escapeHtml(entry.title) + '</b></div>');
                line.on('hover:enter', function () {
                    getStack().push({ id: entry.id, title: entry.title });
                    self.openCurrent();
                });
                return line;
            }
            return renderVideoRow(entry, /*episode*/ entry._episode || null, /*card*/ null);
        }

        function renderSeriesRow(entry) {
            // Виртуальная папка сериала+сезона
            var line = $('<div class="selector dlna-row dlna-row--series" style="margin:0.3em 1em; padding:0.6em 1em; background:rgba(255,255,255,0.06); border-radius:0.5em; display:flex; align-items:center; gap:0.9em;"></div>');
            var poster = $('<div class="dlna-row__poster" style="flex:0 0 auto; width:4.5em; height:6.5em; border-radius:0.3em; background:rgba(255,255,255,0.08) center/cover no-repeat; display:flex; align-items:center; justify-content:center;"></div>');
            poster.html('<div style="opacity:0.4;">' + ICON_FOLDER + '</div>');
            line.append(poster);

            var info = $('<div class="dlna-row__info" style="flex:1 1 auto; min-width:0;"></div>');
            info.append('<div class="dlna-row__title" style="font-weight:600; font-size:1.05em;">' + escapeHtml(entry.show) + '</div>');
            info.append('<div class="dlna-row__local" style="font-size:0.85em; opacity:0.7; margin-top:0.2em;">Сезон ' + entry.season + ' · ' + entry.episodes.length + ' серий</div>');
            info.append('<div class="dlna-row__tmdb" style="font-size:0.82em; opacity:0.85; margin-top:0.3em; color:#ffd966;">ищу в TMDB…</div>');
            line.append(info);

            // TMDB-поиск как сериал
            tmdbSearch(entry.show, null, 'tv', function (hit) {
                var box = info.find('.dlna-row__tmdb');
                if (!hit) {
                    box.text('TMDB: не найдено').css('color', '#888');
                    return;
                }
                var name = hit.name || hit.original_name || entry.show;
                var year = (hit.first_air_date || '').slice(0, 4);
                info.find('.dlna-row__title').text(name + (year ? ' (' + year + ')' : ''));
                var bits = [];
                if (hit.vote_average) bits.push('<span style="color:#ffd966;">★ ' + hit.vote_average.toFixed(1) + '</span>');
                if (hit.original_name && hit.original_name !== name) bits.push('<span style="opacity:0.7;">' + escapeHtml(hit.original_name) + '</span>');
                box.html(bits.join(' · ') || '');
                if (hit.poster_path) {
                    poster.css({
                        'background-image': 'url("' + tmdbPosterUrl(hit.poster_path, 'w200') + '")',
                        'background-size': 'cover',
                        'background-position': 'center'
                    });
                    poster.empty();
                }
                entry.tmdb = hit;
            });

            line.on('hover:enter', function () {
                getStack().push({
                    kind: 'episodes',
                    title: (entry.tmdb ? (entry.tmdb.name || entry.tmdb.original_name) : entry.show) + ' · Сезон ' + entry.season,
                    payload: entry.episodes.map(function (e) {
                        e._series = entry;
                        return e;
                    })
                });
                self.openCurrent();
            });
            return line;
        }

        function renderVideoRow(entry, episode, _card) {
            // hash: для TMDB-фильма Utils.hash(original_title), для серии — с season+episode,
            // иначе — fallback по url. После TMDB-резолва пересчитаем.
            var seriesTmdb = entry._series && entry._series.tmdb;
            var hash;
            if (episode && seriesTmdb) {
                hash = lampaHash(seriesTmdb, episode.season, episode.episode) || fileHash(entry.url || entry.id);
            } else {
                hash = fileHash(entry.url || entry.id || (Date.now() + '_' + Math.random()));
            }
            entry._hash = hash;

            var savedTl = (window.Lampa && Lampa.Timeline) ? Lampa.Timeline.view(hash) : null;

            // Для серий — широкий still (16:9), для фильмов — постер 2:3
            var posterStyle = episode
                ? 'flex:0 0 auto; width:8em; height:4.5em; border-radius:0.3em; background:rgba(255,255,255,0.08) center/cover no-repeat; display:flex; align-items:center; justify-content:center; position:relative;'
                : 'flex:0 0 auto; width:4.5em; height:6.5em; border-radius:0.3em; background:rgba(255,255,255,0.08) center/cover no-repeat; display:flex; align-items:center; justify-content:center; position:relative;';

            var line = $('<div class="selector dlna-row dlna-row--video" data-hash="' + hash + '" style="margin:0.3em 1em; padding:0.6em 1em; background:rgba(255,255,255,0.06); border-radius:0.5em; display:flex; align-items:center; gap:0.9em;"></div>');
            var poster = $('<div class="dlna-row__poster" style="' + posterStyle + '"></div>');
            poster.html('<div style="opacity:0.4;">' + ICON_VIDEO + '</div>');
            if (savedTl && savedTl.percent >= 80) {
                poster.append('<div style="position:absolute; top:0.2em; right:0.2em; width:1.2em; height:1.2em; background:#7ed957; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#000; font-size:0.7em; font-weight:bold;">✓</div>');
            }
            line.append(poster);

            // Для серий: если есть мета TMDB — используем её. Иначе — техническое имя.
            var info = $('<div class="dlna-row__info" style="flex:1 1 auto; min-width:0;"></div>');
            if (episode) {
                var ep = entry._tmdbEpisode;
                var prefix = 'S' + episode.season.toString().padStart(2, '0') + 'E' + episode.episode.toString().padStart(2, '0');
                var name = ep && ep.name ? ep.name : ('Серия ' + episode.episode);
                info.append('<div class="dlna-row__title" style="font-weight:600; font-size:1.05em;"><span style="color:#7ed957; font-family:monospace; margin-right:0.5em;">' + prefix + '</span>' + escapeHtml(name) + '</div>');
                if (ep && ep.still_path) {
                    poster.css({
                        'background-image': 'url("' + tmdbPosterUrl(ep.still_path, 'w300') + '")',
                        'background-size': 'cover', 'background-position': 'center'
                    });
                    poster.empty();
                    if (savedTl && savedTl.percent >= 80) {
                        poster.append('<div style="position:absolute; top:0.2em; right:0.2em; width:1.2em; height:1.2em; background:#7ed957; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#000; font-size:0.7em; font-weight:bold;">✓</div>');
                    }
                }
                if (ep && ep.overview) {
                    info.append('<div class="dlna-row__overview" style="font-size:0.78em; opacity:0.7; margin-top:0.2em; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">' + escapeHtml(ep.overview) + '</div>');
                }
            } else {
                info.append('<div class="dlna-row__title" style="font-weight:600; font-size:1.05em; word-break:break-word;">' + escapeHtml(entry.title) + '</div>');
            }
            // Локальные метаданные (разрешение, длительность, размер) — мелким серым
            var localMeta = [];
            if (entry.resolution) localMeta.push(entry.resolution);
            if (entry.duration) localMeta.push(entry.duration);
            if (entry.size) localMeta.push(formatSize(entry.size));
            if (localMeta.length) {
                info.append('<div class="dlna-row__local" style="font-size:0.75em; opacity:0.5; margin-top:0.2em;">' + escapeHtml(localMeta.join(' · ')) + '</div>');
            }
            // TMDB-блок только для одиночных фильмов
            if (!episode) {
                info.append('<div class="dlna-row__tmdb" style="font-size:0.82em; opacity:0.85; margin-top:0.3em; color:#ffd966;">ищу в TMDB…</div>');
            }
            if (savedTl && savedTl.percent > 0) {
                var bar = $('<div class="dlna-row__progress" style="margin-top:0.4em; height:0.3em; background:rgba(255,255,255,0.1); border-radius:0.15em; overflow:hidden;"><div style="height:100%; background:#7ed957; width:' + Math.min(100, savedTl.percent) + '%;"></div></div>');
                info.append(bar);
            }
            line.append(info);

            // TMDB-обогащение для одиночного фильма
            if (!episode) {
                var parsed = parseFilename(entry.title);
                tmdbSearch(parsed.title, parsed.year, 'movie', function (hit) {
                    var box = info.find('.dlna-row__tmdb');
                    if (!hit) {
                        box.text(parsed.year ? ('TMDB: не найдено · ' + parsed.title + ' (' + parsed.year + ')') : 'TMDB: не найдено').css('color', '#888');
                        return;
                    }
                    var tmdbTitle = hit.title || hit.original_title || parsed.title;
                    var year = (hit.release_date || '').slice(0, 4);
                    info.find('.dlna-row__title').text(tmdbTitle + (year ? ' (' + year + ')' : ''));
                    var bits = [];
                    if (hit.vote_average) bits.push('<span style="color:#ffd966;">★ ' + hit.vote_average.toFixed(1) + '</span>');
                    if (hit.original_title && hit.original_title !== tmdbTitle) bits.push('<span style="opacity:0.7;">' + escapeHtml(hit.original_title) + '</span>');
                    box.html(bits.join(' · ') || '');
                    if (hit.poster_path) {
                        poster.css({
                            'background-image': 'url("' + tmdbPosterUrl(hit.poster_path, 'w200') + '")',
                            'background-size': 'cover', 'background-position': 'center'
                        });
                        poster.empty();
                    }
                    if (hit.overview) {
                        if (info.find('.dlna-row__overview').length === 0) {
                            info.append('<div class="dlna-row__overview" style="font-size:0.78em; opacity:0.7; margin-top:0.3em; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;"></div>');
                        }
                        info.find('.dlna-row__overview').text(hit.overview);
                    }
                    entry.tmdb = hit;
                    // Перезаписываем hash на LAMPA-формат — чтобы прогресс был виден на main TMDB-карточке
                    var newHash = lampaHash(hit);
                    if (newHash) updateRowHash(line, info, entry, newHash);
                });
            }

            line.on('hover:enter', function () { playEntry(entry, episode); });
            return line;
        }

        function updateRowHash(line, info, entry, newHash) {
            entry._hash = newHash;
            line.attr('data-hash', newHash);
            // Обновим прогресс-бар если есть
            var tl = Lampa.Timeline.view(newHash);
            info.find('.dlna-row__progress').remove();
            if (tl && tl.percent > 0) {
                var bar = $('<div class="dlna-row__progress" style="margin-top:0.4em; height:0.3em; background:rgba(255,255,255,0.1); border-radius:0.15em; overflow:hidden;"><div style="height:100%; background:linear-gradient(90deg,#3a73ff,#7ed957); width:' + Math.min(100, tl.percent) + '%;"></div></div>');
                info.append(bar);
            }
        }

        function playEntry(entry, episode) {
            if (!entry.url) { Lampa.Noty.show('Нет URL для воспроизведения'); return; }

            var seriesTmdb = entry._series && entry._series.tmdb;
            var card;
            var hash;
            var title;

            if (episode && seriesTmdb) {
                // Сериал с TMDB
                card = Object.assign({}, seriesTmdb, { source: 'tmdb', method: 'tv' });
                hash = lampaHash(card, episode.season, episode.episode) || fileHash(entry.url);
                title = (card.name || card.original_name) + ' · S' + episode.season + 'E' + episode.episode;
            } else if (entry.tmdb) {
                // Одиночный фильм с TMDB
                card = Object.assign({}, entry.tmdb, { source: 'tmdb', method: 'movie' });
                hash = lampaHash(card) || fileHash(entry.url);
                title = card.title || card.original_title;
            } else {
                // Без TMDB — fallback
                hash = entry._hash || fileHash(entry.url);
                card = buildCard(entry, hash);
                title = entry.title;
            }

            var durSec = parseDurationToSeconds(entry.duration);
            var timeline = (Lampa.Timeline && Lampa.Timeline.view) ? Lampa.Timeline.view(hash) : null;
            if (timeline && durSec && !timeline.duration) {
                timeline.duration = durSec;
                if (timeline.handler) timeline.handler(timeline.percent || 0, timeline.time || 0, durSec);
            }

            try {
                if (Lampa.Favorite && Lampa.Favorite.add) Lampa.Favorite.add('history', card, 100);
            } catch (e) {}

            Lampa.Player.play({ title: title, url: entry.url, card: card, timeline: timeline });
            Lampa.Player.playlist([{ title: title, url: entry.url, card: card, timeline: timeline }]);
        }

        this.render = function () { return html; };

        this.start = function () {
            if (Lampa.Activity.active() && Lampa.Activity.active().activity !== this.activity) return;

            // Контроллер tabs: левый/правый — между табами, down — в контент, up — в LAMPA-head.
            // dlna_tabs: left/right переключают вкладку напрямую, без Navigator
            // (Lampa Navigator плохо ходит между tabs во flex-row на Tizen).
            function moveTab(delta) {
                var idx = TABS.findIndex(function (t) { return t.id === currentTab; });
                if (idx < 0) idx = 0;
                var next = (idx + delta + TABS.length) % TABS.length;
                if (TABS[next].id === currentTab) return;
                switchTab(TABS[next].id);
            }
            Lampa.Controller.add('dlna_tabs', {
                invisible: true,
                toggle: function () {
                    Lampa.Controller.collectionSet(tabsRow);
                    var activeTab = tabsRow.find('.dlna-keenetic__tab--active')[0];
                    if (activeTab) Lampa.Controller.collectionFocus(activeTab, tabsRow);
                    else Lampa.Controller.collectionFocus(false, tabsRow);
                },
                left:  function () { moveTab(-1); },
                right: function () { moveTab(1); },
                up:    function () { Lampa.Controller.toggle('head'); },
                down:  function () { Lampa.Controller.toggle('content'); },
                back:  function () { Lampa.Activity.backward(); }
            });

            Lampa.Controller.add('content', {
                invisible: true,
                toggle: function () {
                    // Ограничиваем коллекцию ТОЛЬКО body (список под tabs).
                    // Иначе Navigator пересекает tabs (они в html выше body),
                    // даёт им призрачный focus, но switchTab не вызывается.
                    Lampa.Controller.collectionSet(body);
                    Lampa.Controller.collectionFocus(false, body);
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('dlna_tabs');
                },
                down:  function () { if (Navigator.canmove('down'))  Navigator.move('down'); },
                left:  function () { if (Navigator.canmove('left'))  Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
                right: function () { if (Navigator.canmove('right')) Navigator.move('right'); },
                back: function () {
                    var s = getStack();
                    if (s.length > 1) { s.pop(); self.openCurrent(); }
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
            // Layout: head не входит в scroll, чтобы скролл правильно считал свою высоту
            '.dlna-keenetic{display:flex;flex-direction:column;height:100%;}' +
            '.dlna-keenetic__head{flex:0 0 auto;padding:0.4em 1.2em 0.6em;}' +
            '.dlna-keenetic__head-path{font-size:0.85em;opacity:0.6;word-break:break-all;margin-bottom:0.4em;}' +
            '.dlna-keenetic__body{flex:1 1 auto;min-height:0;}' +
            // Tabs: горизонтальный ряд
            '.dlna-keenetic__tabs{display:flex;gap:0.4em;flex-wrap:wrap;}' +
            '.dlna-keenetic__tab{padding:0.5em 1.1em;border-radius:0.4em;font-weight:600;cursor:pointer;background:transparent;opacity:0.6;}' +
            // Active — текст ярче, без фона
            '.dlna-keenetic__tab--active{opacity:1;color:#ffd966;}' +
            // Focus — заметная белая обводка через box-shadow inset (без layout shift, без blur)
            '.dlna-keenetic__tab.focus,' +
            '.dlna-keenetic__tab.hover{background:rgba(255,255,255,0.18)!important;opacity:1;}' +
            // Selector: только легкое осветление фона на focus.
            // Никаких теней/outline/transition — Tizen WebKit 76 на TV лагает.
            '.dlna-keenetic .selector{position:relative;}' +
            '.dlna-keenetic .selector.focus,' +
            '.dlna-keenetic .selector.hover{background:rgba(255,255,255,0.18)!important;}' +
            // SVG — ограничиваем размер, иначе LAMPA-стили растягивают на 100%
            '.dlna-keenetic svg{width:1.2em!important;height:1.2em!important;flex:0 0 auto!important;display:inline-block!important;vertical-align:-0.2em!important;}' +
            '.dlna-keenetic .dlna-row__poster svg{width:2em!important;height:2em!important;}';
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
