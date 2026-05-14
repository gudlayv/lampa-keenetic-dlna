(function () {
    'use strict';

    if (window.plugin_keenetic_dlna) return;
    window.plugin_keenetic_dlna = true;

    var PLUGIN_VERSION = '0.9.5';

    // Конфиг через Lampa.SettingsApi (Settings → Keenetic DLNA).
    // dlna_address — IP:port DLNA-сервера Кинетика (default 192.168.1.1:8200, MiniDLNA)
    // dlna_proxy   — публичный HTTPS-URL прокси (cloudflared tunnel + serve.py).
    //                Без прокси TV-браузер не пробьёт CORS preflight + Private Network Access.
    var STORAGE_DLNA_ADDR  = 'dlna_address';
    var STORAGE_DLNA_PROXY = 'dlna_proxy';
    var DEFAULT_DLNA_ADDR  = '192.168.1.1:8200';
    // Совпадает с тем, что поднимает scripts/entware-install.sh — большинство
    // пользователей идут этим путём, поэтому из коробки работает без настройки.
    var DEFAULT_DLNA_PROXY = 'http://192.168.1.1:8780/proxy/';
    var SOAPNS = 'urn:schemas-upnp-org:service:ContentDirectory:1';

    var STORAGE_TR_ADDR  = 'transmission_rpc';
    var STORAGE_TR_USER  = 'transmission_user';
    var STORAGE_TR_PASS  = 'transmission_pass';
    var STORAGE_TR_DIR   = 'transmission_dir';
    var STORAGE_TR_TEST  = 'transmission_test';
    var DEFAULT_TR_ADDR  = '192.168.1.1:8090';
    var DEFAULT_TR_USER  = 'admin';

    function trAddr() {
        return (Lampa.Storage.field(STORAGE_TR_ADDR) || DEFAULT_TR_ADDR)
            .replace(/^https?:\/\//, '').replace(/\/+$/, '');
    }
    function trCreds() {
        var user = Lampa.Storage.field(STORAGE_TR_USER) || '';
        var pass = Lampa.Storage.field(STORAGE_TR_PASS) || '';
        return { user: user, pass: pass };
    }
    function trDownloadDir() {
        return (Lampa.Storage.field(STORAGE_TR_DIR) || '').trim();
    }

    function dlnaAddr() {
        return (Lampa.Storage.field(STORAGE_DLNA_ADDR) || DEFAULT_DLNA_ADDR).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    }
    function proxyBase() {
        var p = (Lampa.Storage.field(STORAGE_DLNA_PROXY) || DEFAULT_DLNA_PROXY).trim();
        if (!p) return '';
        if (!/^https?:\/\//.test(p)) {
            // LAN-IP / localhost → http, остальное → https. Иначе локальный
            // прокси на 192.168.x.x требовал бы вручную писать "http://".
            var host = p.split('/')[0].split(':')[0];
            var isLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|localhost$)/.test(host);
            p = (isLan ? 'http://' : 'https://') + p;
        }
        return p.replace(/\/+$/, '') + '/';
    }
    function controlUrl() { return 'http://' + dlnaAddr() + '/ctl/ContentDir'; }

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

    var BROWSE_PAGE = 500;
    var BROWSE_HARD_CAP = 50000; // защита от бесконечного цикла на кривом DLNA

    // Один SOAP Browse-запрос с произвольным StartingIndex/RequestedCount.
    // Возвращает {entries, numberReturned, totalMatches}.
    function browsePage(objectId, startingIndex, requestedCount, success, error) {
        var proxy = proxyBase();
        if (!proxy) {
            error({ status: 0, message: 'no_proxy' });
            return;
        }
        var soapBody =
            '<?xml version="1.0"?>\n' +
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
            '<s:Body><u:Browse xmlns:u="' + SOAPNS + '">' +
            '<ObjectID>' + escapeHtml(objectId) + '</ObjectID>' +
            '<BrowseFlag>BrowseDirectChildren</BrowseFlag>' +
            '<Filter>*</Filter>' +
            '<StartingIndex>' + startingIndex + '</StartingIndex>' +
            '<RequestedCount>' + requestedCount + '</RequestedCount>' +
            '<SortCriteria></SortCriteria>' +
            '</u:Browse></s:Body></s:Envelope>';

        $.ajax({
            url: proxy + controlUrl(),
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

    // Пагинированный Browse: повторяет browsePage пока NumberReturned > 0
    // и общая длина < TotalMatches. На библиотеках >1000 файлов без этого
    // терялся хвост (MiniDLNA отдает максимум RequestedCount за раз).
    function browse(objectId, success, error) {
        var all = [];
        var totalMatches = null;
        function step(start) {
            if (all.length >= BROWSE_HARD_CAP) {
                console.warn('[dlna] browse hit hard cap', BROWSE_HARD_CAP);
                success(all);
                return;
            }
            browsePage(objectId, start, BROWSE_PAGE, function (page) {
                var entries = page.entries || [];
                if (totalMatches === null) totalMatches = page.totalMatches;
                for (var i = 0; i < entries.length; i++) all.push(entries[i]);
                var nr = page.numberReturned;
                // Стоп: пустая страница, не дотягиваем requested, или знаем total.
                if (!nr || nr < BROWSE_PAGE || (totalMatches > 0 && all.length >= totalMatches)) {
                    success(all);
                    return;
                }
                step(start + nr);
            }, function (err) {
                // Если первая страница упала — наверх как ошибка.
                // Если упали на 2-й+ — отдадим что собрали, лучше частично чем пусто.
                if (all.length === 0) error(err);
                else { console.warn('[dlna] browse page failed at start=' + start, err); success(all); }
            });
        }
        step(0);
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
        var numEl = xmlDoc.getElementsByTagName('NumberReturned')[0];
        var totEl = xmlDoc.getElementsByTagName('TotalMatches')[0];
        return {
            entries: entries,
            numberReturned: numEl ? parseInt(numEl.textContent, 10) : entries.length,
            totalMatches: totEl ? parseInt(totEl.textContent, 10) : 0
        };
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

    // Срезаем release-group тег вида "[NovaFilm] " в начале и нормализуем разделители.
    function cleanShow(s) {
        return String(s || '').replace(/^\[[^\]]+\][\s._\-]*/, '').replace(/[._]+/g, ' ').trim();
    }

    // Парсим эпизод: SxxExx или 1x03. Возвращает {show, season, episode} или null.
    // Покрытые форматы:
    //   "Show.Name.S01E03.mkv"          → show="Show Name", s=1, e=3
    //   "Show Name 1x03.mkv"            → show="Show Name", s=1, e=3
    //   "[NovaFilm] Show.Name.S01E03"   → tag срезается, show="Show Name"
    //   "S01E03 - Title.mkv"            → show="Title" (suffix как имя)
    //   "S01E03.mkv"                    → show="" (попадет в группу с пустым именем)
    function parseEpisode(name) {
        name = name.replace(/\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i, '');
        // Стандартный случай: префикс с именем шоу + SxxExx
        var m = name.match(/^(.+?)[._\s\-]+S(\d{1,2})[._\s\-]?E(\d{1,3})/i);
        if (m) {
            return { show: cleanShow(m[1]), season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
        }
        m = name.match(/^(.+?)[._\s\-]+(\d{1,2})x(\d{1,3})\b/i);
        if (m) {
            return { show: cleanShow(m[1]), season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
        }
        // Без префикса: "S01E03[ - Title].mkv". Без такого fallback'a файлы
        // вида "S01E03.mkv" уходили в "Фильмы" — теперь группируются.
        m = name.match(/^S(\d{1,2})[._\s\-]?E(\d{1,3})(?:[._\s\-]+(.+))?$/i);
        if (m) {
            return { show: cleanShow(m[3] || ''), season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
        }
        return null;
    }

    // TMDB search через API ключ LAMPA. type: 'movie' | 'tv'
    // Кеши с soft-LRU (FIFO eviction): на крупной библиотеке без cap'a
    // словари растут безгранично пока вкладка жива.
    var TMDB_CACHE_MAX = 500;
    var tmdbCache = Object.create(null);
    var tmdbCacheOrder = [];
    function tmdbCachePut(key, val) {
        if (!(key in tmdbCache)) {
            tmdbCacheOrder.push(key);
            if (tmdbCacheOrder.length > TMDB_CACHE_MAX) {
                var evict = tmdbCacheOrder.shift();
                delete tmdbCache[evict];
            }
        }
        tmdbCache[key] = val;
    }
    // Дедуп параллельных запросов с одинаковым ключом — иначе при первом
    // рендере страницы 2-3 строки одного сериала шлют один и тот же запрос.
    var tmdbInflight = Object.create(null);
    function tmdbSearch(title, year, type, cb) {
        if (typeof type === 'function') { cb = type; type = 'movie'; }
        type = type || 'movie';
        var key = type + '|' + title + '|' + (year || '');
        if (key in tmdbCache) { cb(tmdbCache[key]); return; }
        if (tmdbInflight[key]) { tmdbInflight[key].push(cb); return; }
        if (!window.Lampa || !Lampa.TMDB) { cb(null); return; }
        tmdbInflight[key] = [cb];
        var qParam = type === 'tv' ? '&first_air_date_year=' : '&year=';
        var url = Lampa.TMDB.api('search/' + type + '?api_key=' + Lampa.TMDB.key() +
            '&language=ru&query=' + encodeURIComponent(title) +
            (year ? qParam + year : '') +
            '&include_adult=false');
        var network = new Lampa.Reguest();
        network.timeout(10000);
        function flush(hit) {
            var subs = tmdbInflight[key] || [];
            delete tmdbInflight[key];
            subs.forEach(function (s) { try { s(hit); } catch (e) {} });
        }
        network.silent(url, function (data) {
            var hit = (data && data.results && data.results[0]) || null;
            tmdbCachePut(key, hit);
            flush(hit);
        }, function () { flush(null); });
    }

    function tmdbPosterUrl(posterPath, size) {
        if (!posterPath || !window.Lampa || !Lampa.TMDB) return '';
        return Lampa.TMDB.image('t/p/' + (size || 'w200') + posterPath);
    }

    // Получить мету сезона: episodes с name, overview, still_path, vote_average
    var TMDB_SEASON_CACHE_MAX = 200;
    var tmdbSeasonCache = Object.create(null);
    var tmdbSeasonCacheOrder = [];
    function tmdbSeasonCachePut(key, val) {
        if (!(key in tmdbSeasonCache)) {
            tmdbSeasonCacheOrder.push(key);
            if (tmdbSeasonCacheOrder.length > TMDB_SEASON_CACHE_MAX) {
                var evict = tmdbSeasonCacheOrder.shift();
                delete tmdbSeasonCache[evict];
            }
        }
        tmdbSeasonCache[key] = val;
    }
    function tmdbSeason(seriesId, seasonNumber, cb) {
        var key = seriesId + ':s' + seasonNumber;
        if (key in tmdbSeasonCache) { cb(tmdbSeasonCache[key]); return; }
        var url = Lampa.TMDB.api('tv/' + seriesId + '/season/' + seasonNumber + '?api_key=' + Lampa.TMDB.key() + '&language=ru');
        var network = new Lampa.Reguest();
        network.timeout(10000);
        network.silent(url, function (data) {
            tmdbSeasonCachePut(key, data);
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

    // Параллельный пул с ограниченным concurrency. Каждая задача — функция (done).
    function runPool(tasks, concurrency, onAllDone) {
        if (!tasks.length) { onAllDone(); return; }
        var i = 0, running = 0, finished = 0, total = tasks.length;
        function next() {
            while (running < concurrency && i < total) {
                running++;
                var task = tasks[i++];
                task(function () {
                    running--; finished++;
                    if (finished === total) onAllDone();
                    else next();
                });
            }
        }
        next();
    }

    // ===== IndexService =====
    // Фоновый индекс DLNA с матчингом на TMDB. Источник истины для
    // вкладки "Movies", кнопки на стандартной карточке LAMPA и Activity
    // "Список серий". Поднимается на app:ready, кеш в Lampa.Storage.

    var INDEX_STORAGE_KEY = 'dlna_index_v1';
    var INDEX_VERSION = 1;
    var INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    // localStorage origin-quota обычно 5MB. На крупной DLNA-библиотеке
    // (5000+ файлов) сериализованный snapshot (entries + URL-карты)
    // легко перевалит, Lampa.Storage.set молча отвалится в catch — стухший
    // кеш сидит forever. Этот лимит — soft warning при оверхеде; индекс
    // продолжит работать в памяти, но persist отключаем.
    var INDEX_PERSIST_MAX_BYTES = 4 * 1024 * 1024; // 4MB запас от 5MB квоты

    var IndexService = (function () {
        var listeners = { ready: [], updated: [], error: [] };
        var state = {
            status: 'idle',
            byMovieId: Object.create(null),   // map: tmdb_id → Entry[]
            bySeriesId: Object.create(null),  // map: tmdb_id → { byEp: {SxxExx: Entry}, seasons: Set }
            allEntries: [],
            ts: 0,
            addr: '',
            error: null
        };
        var inflight = null; // promise-like guard для refresh/quickCheck

        function epKey(season, episode) {
            return 'S' + season + 'E' + episode;
        }

        function fire(type, payload) {
            (listeners[type] || []).forEach(function (cb) {
                try { cb(payload); } catch (e) {}
            });
            // Дублируем в общий Listener, чтобы CardButton и др. могли
            // подписываться через стандартный механизм LAMPA.
            try {
                if (window.Lampa && Lampa.Listener) {
                    Lampa.Listener.send('dlna_index', Object.assign({ type: type }, payload || {}));
                }
            } catch (e) {}
        }

        function rebuildMaps(entries, moviesMap, seriesMap) {
            // Восстанавливаем byMovieId/bySeriesId из flat-списка entries
            // (используется и при load, и при инкрементальном refresh).
            var byUrl = Object.create(null);
            entries.forEach(function (e) { if (e.url) byUrl[e.url] = e; });

            var byMovie = Object.create(null);
            Object.keys(moviesMap || {}).forEach(function (id) {
                var urls = moviesMap[id] || [];
                var arr = [];
                urls.forEach(function (u) { if (byUrl[u]) arr.push(byUrl[u]); });
                if (arr.length) byMovie[id] = arr;
            });

            var bySeries = Object.create(null);
            Object.keys(seriesMap || {}).forEach(function (id) {
                var byEp = Object.create(null);
                var seasons = Object.create(null);
                var epMap = seriesMap[id] || {};
                Object.keys(epMap).forEach(function (k) {
                    var u = epMap[k];
                    if (byUrl[u]) {
                        byEp[k] = byUrl[u];
                        var m = k.match(/^S(\d+)E\d+$/);
                        if (m) seasons[parseInt(m[1], 10)] = true;
                    }
                });
                if (Object.keys(byEp).length) {
                    bySeries[id] = { byEp: byEp, seasons: Object.keys(seasons).map(Number).sort(function (a, b) { return a - b; }) };
                }
            });

            return { byMovieId: byMovie, bySeriesId: bySeries };
        }

        var persistOversizeWarned = false;
        function persist() {
            try {
                if (!window.Lampa || !Lampa.Storage) return;
                var movies = Object.create(null);
                Object.keys(state.byMovieId).forEach(function (id) {
                    movies[id] = state.byMovieId[id].map(function (e) { return e.url; }).filter(Boolean);
                });
                var series = Object.create(null);
                Object.keys(state.bySeriesId).forEach(function (id) {
                    var m = state.bySeriesId[id].byEp;
                    var out = Object.create(null);
                    Object.keys(m).forEach(function (k) { if (m[k].url) out[k] = m[k].url; });
                    series[id] = out;
                });
                var snapshot = {
                    version: INDEX_VERSION,
                    ts: state.ts,
                    addr: state.addr,
                    entries: state.allEntries,
                    movies: movies,
                    series: series
                };
                // Estimate size заранее: stringify дешевле чем уйти в catch
                // и оставить старый снапшот после QuotaExceeded.
                var bytes = JSON.stringify(snapshot).length;
                if (bytes > INDEX_PERSIST_MAX_BYTES) {
                    if (!persistOversizeWarned && window.Lampa && Lampa.Noty) {
                        Lampa.Noty.show('DLNA: индекс ' + Math.round(bytes / 1024 / 1024) + 'MB, кеш отключен (работаем in-memory)');
                        persistOversizeWarned = true;
                    }
                    // Чистим возможный старый снапшот меньшего размера —
                    // он был валидным при меньшей библиотеке, теперь устарел.
                    try { Lampa.Storage.set(INDEX_STORAGE_KEY, ''); } catch (e) {}
                    return;
                }
                Lampa.Storage.set(INDEX_STORAGE_KEY, snapshot);
            } catch (e) {}
        }

        function load() {
            try {
                if (!window.Lampa || !Lampa.Storage) return;
                var snap = Lampa.Storage.get(INDEX_STORAGE_KEY, '');
                if (!snap || typeof snap !== 'object') return;
                if (snap.version !== INDEX_VERSION) {
                    // Стухший снапшот другой версии — чистим явно, иначе
                    // мусор сидит forever и ест квоту.
                    try { Lampa.Storage.set(INDEX_STORAGE_KEY, ''); } catch (e) {}
                    return;
                }
                if (snap.addr && snap.addr !== dlnaAddr()) return; // адрес сменился — кеш не валиден
                state.allEntries = Array.isArray(snap.entries) ? snap.entries : [];
                var maps = rebuildMaps(state.allEntries, snap.movies || {}, snap.series || {});
                state.byMovieId = maps.byMovieId;
                state.bySeriesId = maps.bySeriesId;
                state.ts = snap.ts || 0;
                state.addr = snap.addr || dlnaAddr();
                state.status = 'ready';
                state.error = null;
                fire('ready', { fromCache: true });
            } catch (e) {}
        }

        // Внутренний sweep: получает плоский список Entry'ев из All Video.
        // success(entries), error({message}).
        function sweepBrowse(success, error) {
            findAllVideoId(function (allVideoId) {
                if (!allVideoId) { error({ message: 'no_all_video' }); return; }
                browse(allVideoId, function (entries) { success(entries); }, function (err) { error(err); });
            });
        }

        // Полная пересборка индекса.
        function doFullRefresh(done) {
            sweepBrowse(function (rawEntries) {
                // Разбиваем на одиночки и группы серий
                var singles = [];
                var seriesGroupsByKey = Object.create(null);
                rawEntries.forEach(function (e) {
                    if (e.isFolder) return; // папки внутри All Video — игнорируем
                    var ep = parseEpisode(e.title);
                    if (ep) {
                        e._episode = ep;
                        var key = ep.show.toLowerCase();
                        if (!seriesGroupsByKey[key]) seriesGroupsByKey[key] = { show: ep.show, episodes: [] };
                        seriesGroupsByKey[key].episodes.push(e);
                    } else {
                        e._parsed = parseFilename(e.title);
                        singles.push(e);
                    }
                });

                var newByMovie = Object.create(null);
                var newBySeries = Object.create(null);
                var allEntries = [];

                // TMDB-запросы для фильмов параллельно с ограничением.
                var movieTasks = singles.map(function (entry) {
                    return function (taskDone) {
                        tmdbSearch(entry._parsed.title, entry._parsed.year, 'movie', function (hit) {
                            if (hit && hit.id != null) {
                                entry._tmdb = hit;
                                var arr = newByMovie[hit.id] || (newByMovie[hit.id] = []);
                                arr.push(entry);
                            }
                            allEntries.push(entry);
                            taskDone();
                        });
                    };
                });

                // 1 TMDB-запрос на сериал (на группу).
                var seriesTasks = Object.keys(seriesGroupsByKey).map(function (gk) {
                    var grp = seriesGroupsByKey[gk];
                    return function (taskDone) {
                        tmdbSearch(grp.show, null, 'tv', function (hit) {
                            if (hit && hit.id != null) {
                                var bucket = newBySeries[hit.id];
                                if (!bucket) {
                                    bucket = newBySeries[hit.id] = { byEp: Object.create(null), seasons: [] };
                                }
                                var seasonsSet = Object.create(null);
                                bucket.seasons.forEach(function (s) { seasonsSet[s] = true; });
                                grp.episodes.forEach(function (ep) {
                                    ep._tmdb = hit;
                                    var k = epKey(ep._episode.season, ep._episode.episode);
                                    bucket.byEp[k] = ep;
                                    seasonsSet[ep._episode.season] = true;
                                });
                                bucket.seasons = Object.keys(seasonsSet).map(Number).sort(function (a, b) { return a - b; });
                            }
                            grp.episodes.forEach(function (ep) { allEntries.push(ep); });
                            taskDone();
                        });
                    };
                });

                var allTasks = movieTasks.concat(seriesTasks);
                runPool(allTasks, 5, function () {
                    state.byMovieId = newByMovie;
                    state.bySeriesId = newBySeries;
                    state.allEntries = allEntries;
                    state.ts = Date.now();
                    state.addr = dlnaAddr();
                    state.status = 'ready';
                    state.error = null;
                    persist();
                    fire('updated', { fromCache: false });
                    done(null);
                });
            }, function (err) {
                state.status = 'error';
                state.error = err && err.message ? err.message : 'browse_failed';
                fire('error', { error: state.error });
                done(state.error);
            });
        }

        // quickCheck: легкий sweep, сравнение URL-сета с кешем.
        // diff → fallback к doFullRefresh (инкрементальная версия не дает
        // существенной экономии — TMDB-кеш уже работает, а парсинг дешев).
        function doQuickCheck(done) {
            sweepBrowse(function (rawEntries) {
                var nowFiles = rawEntries.filter(function (e) { return !e.isFolder && e.url; });
                var oldUrls = Object.create(null);
                state.allEntries.forEach(function (e) { if (e.url) oldUrls[e.url] = true; });
                var newUrls = Object.create(null);
                nowFiles.forEach(function (e) { newUrls[e.url] = true; });
                var sameSize = nowFiles.length === state.allEntries.length;
                var same = sameSize && Object.keys(newUrls).every(function (u) { return oldUrls[u]; });
                if (same) {
                    state.ts = Date.now();
                    persist();
                    done(null);
                    return;
                }
                doFullRefresh(done);
            }, function (err) {
                state.status = 'error';
                state.error = err && err.message ? err.message : 'browse_failed';
                fire('error', { error: state.error });
                done(state.error);
            });
        }

        function refresh(opts, done) {
            opts = opts || {};
            done = done || function () {};
            if (inflight) { done('busy'); return; }
            state.status = 'loading';
            inflight = true;
            var fn = opts.full ? doFullRefresh : doQuickCheck;
            // ВАЖНО: doFullRefresh/doQuickCheck должны вызывать done строго
            // асинхронно (через runPool/sweepBrowse). Иначе inflight=null
            // ниже выполнится ПОСЛЕ done — и synchronous callback внутри fn
            // увидит inflight=true и получит 'busy'. Сейчас runPool на пустом
            // списке зовет cb синхронно, но переменная state.status уже
            // 'loading' к моменту fn(), так что регрессии нет — но любая
            // будущая sync-ветка должна оборачиваться в setTimeout(0).
            fn(function (err) {
                inflight = null;
                if (err && state.status !== 'ready') {
                    // status уже выставлен в error внутри fn
                    done(err);
                } else {
                    done(null);
                }
            });
        }

        function quickCheck(done) { refresh({ full: false }, done); }

        function lookupMovie(tmdbId) {
            if (tmdbId == null) return null;
            var arr = state.byMovieId[tmdbId];
            return arr && arr.length ? arr : null;
        }

        function lookupSeries(tmdbId) {
            if (tmdbId == null) return null;
            var b = state.bySeriesId[tmdbId];
            if (!b) return null;
            // byEp в формате Object — преобразуем размер для consumers
            var size = 0;
            for (var _k in b.byEp) if (Object.prototype.hasOwnProperty.call(b.byEp, _k)) size++;
            if (!size) return null;
            return { byEp: b.byEp, seasons: b.seasons, size: size };
        }

        function on(type, cb) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(cb);
        }

        return {
            load: load,
            refresh: refresh,
            quickCheck: quickCheck,
            lookupMovie: lookupMovie,
            lookupSeries: lookupSeries,
            on: on,
            get state() { return state.status; },
            get raw() { return state; }
        };
    })();

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

    // Универсальный плеер для DLNA-entry с TMDB-карточкой.
    // Используется CardButton (стандартная карточка LAMPA),
    // EpisodeListComponent (Activity со списком серий) и
    // Component.playEntry (внутренняя вкладка Movies — как обертка).
    //
    // group (опц.) — массив братских entries того же сезона. Если задан и >1,
    // в Lampa.Player.playlist() уйдут все серии: position автоматически
    // определяется по совпадению url с текущей (см. yumata/lampa-source
    // src/interaction/player/playlist.js → set()).
    function playMovie(entry, card, displayTitle, group) {
        if (!entry || !entry.url) {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Нет URL для воспроизведения');
            return;
        }
        var ep = entry._episode || null;
        var hash = card ? lampaHash(card, ep ? ep.season : null, ep ? ep.episode : null) : null;
        if (!hash) hash = fileHash(entry.url);

        var durSec = parseDurationToSeconds(entry.duration);
        var timeline = (window.Lampa && Lampa.Timeline && Lampa.Timeline.view) ? Lampa.Timeline.view(hash) : null;
        if (timeline) {
            timeline.hash = hash;
            if (durSec && !timeline.duration) {
                timeline.duration = durSec;
                if (timeline.handler) timeline.handler(timeline.percent || 0, timeline.time || 0, durSec);
            }
        }

        try {
            if (card && window.Lampa && Lampa.Favorite && Lampa.Favorite.add) {
                Lampa.Favorite.add('history', card, 100);
            }
        } catch (e) {}

        var title = displayTitle || (card && (card.title || card.name || card.original_title || card.original_name)) || entry.title;

        var playlist;
        if (Array.isArray(group) && group.length > 1) {
            playlist = group.map(function (pe) {
                var pep = pe._episode || null;
                var ph = (card && pep) ? lampaHash(card, pep.season, pep.episode) : fileHash(pe.url);
                var ptl = (window.Lampa && Lampa.Timeline && Lampa.Timeline.view) ? Lampa.Timeline.view(ph) : null;
                if (ptl) {
                    ptl.hash = ph;
                    var pdur = parseDurationToSeconds(pe.duration);
                    if (pdur && !ptl.duration) ptl.duration = pdur;
                }
                var ptmdb = pe._tmdbEpisode;
                var ptitle;
                if (pep) {
                    var pre = 'S' + String(pep.season).padStart(2, '0') + 'E' + String(pep.episode).padStart(2, '0');
                    ptitle = (ptmdb && ptmdb.name) ? (pre + ' · ' + ptmdb.name) : pre;
                } else {
                    ptitle = pe.title || '';
                }
                return { title: ptitle, url: pe.url, timeline: ptl };
            });
        } else {
            playlist = [{ title: title, url: entry.url, timeline: timeline }];
        }

        var playData = { title: title, url: entry.url, card: card || undefined, timeline: timeline };
        // Lampa.Player сам прокидывает data.playlist во внешние плееры (Infuse/tvOS)
        // через query — нужно для multi-URL плейлиста на iOS-плеерах.
        if (playlist.length > 1) playData.playlist = playlist;

        Lampa.Player.play(playData);
        Lampa.Player.playlist(playlist);
    }

    function Component() {
        var currentTab = 'all';
        var stacks = {
            all:     [{ kind: 'all',     title: 'Все видео' }],
            movies:  [{ kind: 'movies',  title: 'Фильмы' }],
            series:  [{ kind: 'series',  title: 'Сериалы' }],
            folders: [{ id: '0',         title: 'Keenetic Ultra' }]
        };
        var html, head, filter, filterItems, body, scroll, self = this;

        this.create = function () {
            html = $('<div class="dlna-keenetic"></div>');
            head = $('<div class="dlna-keenetic__head"></div>');
            body = $('<div class="dlna-keenetic__body"></div>');
            scroll = new Lampa.Scroll({ mask: true, over: true });
            scroll.minus(head);
            body.append(scroll.render(true));
            html.append(head).append(body);
            initFilter();
            this.activity.loader(true);
            // Когда IndexService обновился (или упал) — перерисуем
            // активную вкладку (только если она использует индекс).
            self._onIndex = function (e) {
                if (self._destroyed) return;
                if (currentTab === 'folders') return;
                if (e.type === 'ready' || e.type === 'updated' || e.type === 'error') {
                    self.openCurrent({ skipControllerToggle: true });
                }
            };
            if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('dlna_index', self._onIndex);
            this.openCurrent();
        };

        function initFilter() {
            filter = new Lampa.Filter({});
            filterItems = TABS.map(function (t) {
                return { title: t.title, tabId: t.id, selected: t.id === currentTab };
            });
            filter.set('filter', filterItems);
            filter.onSelect = function (type, item) {
                if (type !== 'filter') return;
                filterItems.forEach(function (i) { i.selected = i.tabId === item.tabId; });
                currentTab = item.tabId;
                updateFilterBadge();
                reloadCurrent();
                // Lampa.Select.hide() при выборе закрывает popup но не возвращает
                // controller — фокус "висит" в скрытом select. Через setTimeout(0)
                // отдадим управление обратно в наш head — после того как Select
                // закончит свой hide-цикл.
                setTimeout(function () {
                    Lampa.Controller.toggle('dlna_head');
                }, 0);
            };
            filter.onBack = function () {
                Lampa.Controller.toggle('dlna_head');
            };
            filter.toggle();
            // Удаляем search-кнопку — у плагина нет поиска
            filter.render().find('.filter--search').remove();
            updateFilterBadge();
        }

        function updateFilterBadge() {
            var t = TABS.find(function (x) { return x.id === currentTab; });
            if (filter && filter.chosen) filter.chosen('filter', t ? [t.title] : []);
        }

        // Открыть Filter Select прямо (используется из right shortcut в любом месте)
        function openFilter() {
            if (filter && filter.show) filter.show('Фильтр', 'filter');
        }

        function getStack() { return stacks[currentTab]; }

        function setHead() {
            head.empty();
            var stack = getStack();
            if (stack.length > 1) {
                var pathRow = $('<div class="dlna-keenetic__head-path"></div>');
                pathRow.text(stack.map(function (s) { return s.title; }).join(' / '));
                head.append(pathRow);
            }
            head.append(filter.render());
        }

        // Перезагрузить текущую вкладку без перетоггливания controllers
        // (вызывается из filter.onSelect — Lampa.Select сам управляет фокусом)
        function reloadCurrent() {
            self.openCurrent({ skipControllerToggle: true });
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

            // Без прокси никаких запросов — сразу красная плашка с инструкцией
            if (!proxyBase()) {
                browseError({ message: 'no_proxy' });
                return;
            }

            // "Папки" — Browse по DLNA-id из стека (живые SOAP-запросы)
            if (currentTab === 'folders') {
                browse(top.id, function (entries) { renderEntries(entries, opts); }, browseError);
                return;
            }

            // "Все/Фильмы/Сериалы" — источник IndexService.
            // Если индекс не готов — показываем лоадер и ждем dlna_index:ready;
            // на холодном старте параллельно дергаем refresh.
            var renderFromIndex = function () {
                var entries = (IndexService.raw && IndexService.raw.allEntries) || [];
                // copy, чтобы не портить state.allEntries порядком сортировки
                entries = entries.slice().sort(function (a, b) {
                    var da = a.date || '', db = b.date || '';
                    return db.localeCompare(da);
                });
                if (currentTab === 'movies') {
                    entries = entries.filter(function (e) { return !e.isFolder && !e._episode; });
                } else if (currentTab === 'series') {
                    entries = entries.filter(function (e) { return !e.isFolder && e._episode; });
                }
                renderEntries(entries, opts);
            };

            var st = IndexService.state;
            if (st === 'ready') {
                renderFromIndex();
            } else if (st === 'error') {
                browseError({ message: (IndexService.raw && IndexService.raw.error) || 'index_error' });
            } else {
                // 'idle' или 'loading' — попросим индекс собраться и
                // подождем события dlna_index:ready (см. подписку в create()).
                if (st === 'idle') {
                    try { IndexService.refresh({ full: true }); } catch (e) {}
                }
                // лоадер уже висит из верха openCurrent
            }
        };

        function browseError(err) {
            scroll.clear();
            if (err && err.message === 'no_proxy') {
                var msg = $('<div style="margin:1em; padding:1.2em; background:rgba(255,217,102,0.15); border-left:4px solid #ffd966; border-radius:0.4em; font-size:0.95em; line-height:1.5;"></div>');
                msg.html(
                    '<b>Прокси не настроен</b><br><br>' +
                    'TV-браузер не может ходить на DLNA-сервер напрямую (CORS / Private Network Access). ' +
                    'Нужен HTTPS-прокси, который форвардит запросы на Кинетик.<br><br>' +
                    'Открой <b>Настройки → Keenetic DLNA</b> и заполни поле <b>«Прокси URL»</b>.<br><br>' +
                    'Как поднять прокси — README: <a href="https://github.com/gudlayv/lampa-keenetic-dlna#proxy" style="color:#ffd966;">github.com/…/lampa-keenetic-dlna</a>'
                );
                scroll.append(msg);
                self.activity.loader(false);
                return;
            }
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
            if (!opts.skipControllerToggle) {
                self.activity.toggle();
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

            function applyTmdbSeries(hit) {
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
            }

            // Если IndexService уже разрезолвил серии — переиспользуем _tmdb
            // первой серии вместо повторного TMDB-запроса.
            var cachedSeriesTmdb = entry.episodes[0] && entry.episodes[0]._tmdb;
            if (cachedSeriesTmdb) {
                applyTmdbSeries(cachedSeriesTmdb);
            } else {
                tmdbSearch(entry.show, null, 'tv', applyTmdbSeries);
            }

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
                poster.append('<div class="dlna-row__watched" style="position:absolute; top:0.2em; right:0.2em; width:1.2em; height:1.2em; background:#7ed957; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#000; font-size:0.7em; font-weight:bold;">✓</div>');
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
                        poster.append('<div class="dlna-row__watched" style="position:absolute; top:0.2em; right:0.2em; width:1.2em; height:1.2em; background:#7ed957; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#000; font-size:0.7em; font-weight:bold;">✓</div>');
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
                var parsed = entry._parsed || parseFilename(entry.title);
                function applyTmdbMovie(hit) {
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
                }
                if (entry._tmdb) applyTmdbMovie(entry._tmdb);
                else tmdbSearch(parsed.title, parsed.year, 'movie', applyTmdbMovie);
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
            if (!entry || !entry.url) {
                if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Нет URL для воспроизведения');
                return;
            }
            var seriesTmdb = (entry._series && entry._series.tmdb) || (episode && entry._tmdb);
            var card;
            var title;
            var group = null;
            if (episode && seriesTmdb) {
                card = Object.assign({}, seriesTmdb, { source: 'tmdb', method: 'tv' });
                title = (card.name || card.original_name) + ' · S' + episode.season + 'E' + episode.episode;
                // Внутри сезона payload текущего стека — все серии этой группы.
                var stack = getStack();
                var top = stack[stack.length - 1];
                if (top && top.kind === 'episodes' && Array.isArray(top.payload)) {
                    group = top.payload;
                }
            } else if (entry.tmdb || entry._tmdb) {
                var hit = entry.tmdb || entry._tmdb;
                card = Object.assign({}, hit, { source: 'tmdb', method: 'movie' });
                title = card.title || card.original_title;
            } else {
                // Без TMDB — fallback-карточка (Folders, не распознанный фильм)
                var fbHash = entry._hash || fileHash(entry.url);
                card = buildCard(entry, fbHash);
                title = entry.title;
            }
            playMovie(entry, card, title, group);
        }

        this.render = function () { return html; };

        this.start = function () {
            if (Lampa.Activity.active() && Lampa.Activity.active().activity !== this.activity) return;

            // Контроллер head: фокус на кнопке Filter из new Lampa.Filter()
            Lampa.Controller.add('dlna_head', {
                invisible: true,
                toggle: function () {
                    Lampa.Controller.collectionSet(head);
                    var filterBtnEl = head.find('.filter--filter')[0];
                    if (filterBtnEl) Lampa.Controller.collectionFocus(filterBtnEl, head);
                    else Lampa.Controller.collectionFocus(false, head);
                },
                up:    function () { Lampa.Controller.toggle('head'); },
                down:  function () { Lampa.Controller.toggle('content'); },
                left:  function () { Lampa.Controller.toggle('menu'); },
                right: function () { openFilter(); },
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
                    else Lampa.Controller.toggle('dlna_head');
                },
                down:  function () { if (Navigator.canmove('down'))  Navigator.move('down'); },
                left:  function () { if (Navigator.canmove('left'))  Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
                // → из любой строки списка открывает popup фильтров — глобальный шорткат
                right: function () { openFilter(); },
                back: function () {
                    var s = getStack();
                    if (s.length > 1) { s.pop(); self.openCurrent(); }
                    else Lampa.Activity.backward();
                }
            });
            Lampa.Controller.toggle('content');
            // При возврате в активити (из плеера) — обновляем визуальный прогресс
            // на строках. LAMPA пишет timeline в Storage сама, но наш DOM был
            // отрисован до начала просмотра.
            refreshProgress();
        };

        function refreshProgress() {
            if (!body || !Lampa.Timeline || !Lampa.Timeline.view) return;
            body.find('.dlna-row[data-hash]').each(function () {
                var row = $(this);
                var hash = row.attr('data-hash');
                if (!hash) return;
                var tl = Lampa.Timeline.view(hash);
                if (!tl) return;

                var info = row.find('.dlna-row__info');
                var bar = info.find('.dlna-row__progress');
                if (tl.percent > 0) {
                    if (!bar.length) {
                        bar = $('<div class="dlna-row__progress" style="margin-top:0.4em; height:0.3em; background:rgba(255,255,255,0.1); border-radius:0.15em; overflow:hidden;"><div style="height:100%; background:#7ed957; width:0%;"></div></div>');
                        info.append(bar);
                    }
                    bar.find('div').css('width', Math.min(100, tl.percent) + '%');
                } else if (bar.length) {
                    bar.remove();
                }

                // Watched-badge ✓ при ≥80%
                var poster = row.find('.dlna-row__poster');
                var badge = poster.find('.dlna-row__watched');
                if (tl.percent >= 80) {
                    if (!badge.length) {
                        poster.append('<div class="dlna-row__watched" style="position:absolute; top:0.2em; right:0.2em; width:1.2em; height:1.2em; background:#7ed957; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#000; font-size:0.7em; font-weight:bold;">✓</div>');
                    }
                } else if (badge.length) {
                    badge.remove();
                }
            });
        }

        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            self._destroyed = true;
            // Парный remove к follow в create() — иначе после N push/pop
            // в шине dlna_index копятся мертвые closures, каждое событие
            // индекса дергает destroyed-компонент.
            if (window.Lampa && Lampa.Listener && self._onIndex) {
                try { Lampa.Listener.remove('dlna_index', self._onIndex); } catch (e) {}
            }
            if (scroll) scroll.destroy();
            if (html) html.remove();
        };
    }

    // ===== EpisodeListComponent =====
    // Activity-компонент со списком серий по DLNA-индексу для конкретной
    // TMDB-карточки сериала. Запускается из CardButton (см. ниже).
    // object.card — карточка TV из IndexService/standard TMDB.
    function EpisodeListComponent(object) {
        var card = object.card || (Lampa.Activity.active() && Lampa.Activity.active().card);
        var html, body, scroll, self = this;

        this.create = function () {
            html = $('<div class="dlna-keenetic dlna-keenetic--episodes"></div>');
            body = $('<div class="dlna-keenetic__body"></div>');
            scroll = new Lampa.Scroll({ mask: true, over: true });
            body.append(scroll.render(true));
            html.append(body);
            this.activity.loader(true);
            renderAll();
        };

        function renderAll() {
            scroll.clear();
            if (!card || card.id == null) {
                scroll.append($('<div style="padding:1.5em; color:#ff6464;">Нет данных о сериале.</div>'));
                self.activity.loader(false);
                self.activity.toggle();
                Lampa.Controller.toggle('content');
                return;
            }
            var match = IndexService.lookupSeries(card.id);
            if (!match) {
                scroll.append($('<div style="padding:1.5em; opacity:0.7;">Серии этого сериала не найдены в DLNA-индексе.</div>'));
                self.activity.loader(false);
                self.activity.toggle();
                Lampa.Controller.toggle('content');
                return;
            }

            // Header: заглушка с инфо о сериале
            var head = $('<div style="margin:0.4em 1em 0.8em; font-size:1.1em; font-weight:600; opacity:0.9;"></div>');
            head.text((card.name || card.original_name || 'Сериал') + ' · DLNA');
            scroll.append(head);

            // Группируем доступные серии по сезонам
            var bySeason = {};
            Object.keys(match.byEp).forEach(function (k) {
                var m = k.match(/^S(\d+)E(\d+)$/);
                if (!m) return;
                var season = parseInt(m[1], 10);
                var episode = parseInt(m[2], 10);
                if (!bySeason[season]) bySeason[season] = [];
                bySeason[season].push({ episode: episode, key: k, entry: match.byEp[k] });
            });
            var seasons = Object.keys(bySeason).map(Number).sort(function (a, b) { return a - b; });

            seasons.forEach(function (season) {
                var sHead = $('<div style="margin:0.8em 1em 0.3em; font-size:0.95em; opacity:0.7;"></div>');
                sHead.text('Сезон ' + season);
                scroll.append(sHead);

                bySeason[season].sort(function (a, b) { return a.episode - b.episode; });

                // Для метаданных серий — один запрос на сезон
                tmdbSeason(card.id, season, function (seasonData) {
                    var byNum = {};
                    if (seasonData && seasonData.episodes) {
                        seasonData.episodes.forEach(function (e) { byNum[e.episode_number] = e; });
                    }
                    // Заранее проставляем _episode/_tmdbEpisode всем entries сезона —
                    // playMovie использует это при сборке плейлиста.
                    var seasonEntries = bySeason[season].map(function (it) {
                        it.entry._episode = it.entry._episode || { season: season, episode: it.episode };
                        it.entry._tmdbEpisode = byNum[it.episode] || null;
                        return it.entry;
                    });
                    bySeason[season].forEach(function (it) {
                        var row = buildEpisodeRow(it.entry, it.episode, season, it.entry._tmdbEpisode, seasonEntries);
                        scroll.append(row);
                    });
                    // hover:focus у первой строки — для scroll-update
                });
            });

            self.activity.loader(false);
            self.activity.toggle();
            Lampa.Controller.toggle('content');
        }

        function buildEpisodeRow(entry, episodeNum, season, tmdbEp, seasonEntries) {
            var seriesCard = card;
            var hash = lampaHash(seriesCard, season, episodeNum) || fileHash(entry.url);
            entry._hash = hash;
            var savedTl = (window.Lampa && Lampa.Timeline && Lampa.Timeline.view) ? Lampa.Timeline.view(hash) : null;

            var line = $('<div class="selector dlna-row dlna-row--video" data-hash="' + hash + '" style="margin:0.3em 1em; padding:0.6em 1em; background:rgba(255,255,255,0.06); border-radius:0.5em; display:flex; align-items:center; gap:0.9em;"></div>');
            var posterStyle = 'flex:0 0 auto; width:8em; height:4.5em; border-radius:0.3em; background:rgba(255,255,255,0.08) center/cover no-repeat; display:flex; align-items:center; justify-content:center; position:relative;';
            var poster = $('<div class="dlna-row__poster" style="' + posterStyle + '"></div>');
            poster.html('<div style="opacity:0.4;">' + ICON_VIDEO + '</div>');
            if (tmdbEp && tmdbEp.still_path) {
                poster.css({
                    'background-image': 'url("' + tmdbPosterUrl(tmdbEp.still_path, 'w300') + '")',
                    'background-size': 'cover', 'background-position': 'center'
                });
                poster.empty();
            }
            if (savedTl && savedTl.percent >= 80) {
                poster.append('<div class="dlna-row__watched" style="position:absolute; top:0.2em; right:0.2em; width:1.2em; height:1.2em; background:#7ed957; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#000; font-size:0.7em; font-weight:bold;">✓</div>');
            }
            line.append(poster);

            var info = $('<div class="dlna-row__info" style="flex:1 1 auto; min-width:0;"></div>');
            var prefix = 'S' + season.toString().padStart(2, '0') + 'E' + episodeNum.toString().padStart(2, '0');
            var name = (tmdbEp && tmdbEp.name) ? tmdbEp.name : ('Серия ' + episodeNum);
            info.append('<div class="dlna-row__title" style="font-weight:600; font-size:1.05em;"><span style="color:#7ed957; font-family:monospace; margin-right:0.5em;">' + prefix + '</span>' + escapeHtml(name) + '</div>');
            if (tmdbEp && tmdbEp.overview) {
                info.append('<div class="dlna-row__overview" style="font-size:0.78em; opacity:0.7; margin-top:0.2em; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">' + escapeHtml(tmdbEp.overview) + '</div>');
            }
            var localMeta = [];
            if (entry.resolution) localMeta.push(entry.resolution);
            if (entry.duration) localMeta.push(entry.duration);
            if (entry.size) localMeta.push(formatSize(entry.size));
            if (localMeta.length) {
                info.append('<div class="dlna-row__local" style="font-size:0.75em; opacity:0.5; margin-top:0.2em;">' + escapeHtml(localMeta.join(' · ')) + '</div>');
            }
            if (savedTl && savedTl.percent > 0) {
                info.append('<div class="dlna-row__progress" style="margin-top:0.4em; height:0.3em; background:rgba(255,255,255,0.1); border-radius:0.15em; overflow:hidden;"><div style="height:100%; background:#7ed957; width:' + Math.min(100, savedTl.percent) + '%;"></div></div>');
            }
            line.append(info);

            line.on('hover:focus', function () { scroll.update(line); });
            line.on('hover:enter', function () {
                var sCard = Object.assign({}, seriesCard, { source: 'tmdb', method: 'tv' });
                // Передаем эпизод-инфу плееру через временное поле,
                // чтобы playMovie мог сгенерировать корректный hash.
                entry._episode = entry._episode || { season: season, episode: episodeNum };
                playMovie(entry, sCard, (sCard.name || sCard.original_name || '') + ' · ' + prefix + (tmdbEp && tmdbEp.name ? (' · ' + tmdbEp.name) : ''), seasonEntries);
            });
            return line;
        }

        this.render = function () { return html; };

        this.start = function () {
            if (Lampa.Activity.active() && Lampa.Activity.active().activity !== this.activity) return;
            Lampa.Controller.add('content', {
                invisible: true,
                toggle: function () {
                    Lampa.Controller.collectionSet(body);
                    Lampa.Controller.collectionFocus(false, body);
                },
                up:    function () { if (Navigator.canmove('up'))    Navigator.move('up'); else Lampa.Controller.toggle('head'); },
                down:  function () { if (Navigator.canmove('down'))  Navigator.move('down'); },
                left:  function () { if (Navigator.canmove('left'))  Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
                right: function () { if (Navigator.canmove('right')) Navigator.move('right'); },
                back:  function () { Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
        };

        this.pause   = function () {};
        this.stop    = function () {};
        this.destroy = function () {
            if (scroll) scroll.destroy();
            if (html) html.remove();
        };
    }

    // ===== CardButton =====
    // DOM-кнопка "Смотреть с DLNA" на стандартной TMDB-карточке LAMPA.
    // Появляется, если IndexService нашел матч; ведет в плеер (фильм)
    // или в Activity со списком серий (сериал).
    var CardButton = (function () {
        var ICON_DLNA =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<rect x="2" y="6" width="20" height="12" rx="2"/>' +
                '<polygon points="10 9 16 12 10 15" fill="currentColor"/>' +
            '</svg>';

        function pluralize(n, forms) {
            // forms: [one, few, many]
            var mod10 = n % 10, mod100 = n % 100;
            if (mod10 === 1 && mod100 !== 11) return forms[0];
            if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
            return forms[2];
        }

        function subtitleFor(match, isSeries) {
            if (isSeries) {
                var sCount = match.seasons ? match.seasons.length : 0;
                var eCount = match.size || 0;
                var s = sCount + ' ' + pluralize(sCount, ['сезон', 'сезона', 'сезонов']);
                var e = eCount + ' ' + pluralize(eCount, ['серия', 'серии', 'серий']);
                return 'DLNA · ' + s + ' · ' + e;
            }
            var entries = match;
            if (entries.length === 1) {
                var dur = entries[0].duration ? ('DLNA · ' + entries[0].duration) : 'DLNA';
                return dur;
            }
            return 'DLNA · ' + entries.length + ' ' + pluralize(entries.length, ['файл', 'файла', 'файлов']);
        }

        function buildButton(match, isSeries, card) {
            var subtitle = subtitleFor(match, isSeries);
            // .full-start__button — нативный класс LAMPA (работает в обеих темах).
            var btn = $('<div class="full-start__button selector view--dlna">' +
                '<div class="full-start__button-tip" style="display:inline-flex;align-items:center;justify-content:center;width:1.5em;height:1.5em;margin-right:0.4em;vertical-align:-0.25em;">' + ICON_DLNA + '</div>' +
                '<span>Смотреть с DLNA</span>' +
                '<div class="full-start__button-subtitle" style="font-size:0.78em;opacity:0.7;margin-top:0.1em;">' + escapeHtml(subtitle) + '</div>' +
            '</div>');
            btn.on('hover:enter', function () { onClick(match, isSeries, card); });
            return btn;
        }

        function onClick(match, isSeries, card) {
            if (isSeries) {
                Lampa.Activity.push({
                    url: '',
                    title: (card.name || card.original_name || 'Сериал') + ' · DLNA',
                    component: 'keenetic_dlna_episodes',
                    card: card,
                    page: 1
                });
                return;
            }
            var entries = match;
            if (entries.length === 1) {
                playMovie(entries[0], card);
                return;
            }
            // Несколько копий — Lampa.Select
            var items = entries.map(function (e) {
                var meta = (e.resolution || 'HD') + ' · ' + (e.size ? formatSize(e.size) : '');
                return {
                    title: meta.trim().replace(/ · $/, ''),
                    subtitle: e.title,
                    entry: e
                };
            });
            if (Lampa.Select && Lampa.Select.show) {
                Lampa.Select.show({
                    title: 'Выбор файла',
                    items: items,
                    onSelect: function (item) { playMovie(item.entry, card); },
                    onBack: function () { Lampa.Controller.toggle('full-start'); }
                });
            } else {
                // Fallback: играем первый
                playMovie(entries[0], card);
            }
        }

        function tryInject(activity) {
            try {
                if (!activity || !activity.card) return;
                var card = activity.card;
                if (card.id == null) return;
                var isSeries = card.method === 'tv' || card.name != null || card.number_of_seasons != null || card.first_air_date != null;
                var match = isSeries ? IndexService.lookupSeries(card.id) : IndexService.lookupMovie(card.id);
                if (!match) return;
                if (isSeries && (!match.size)) return;

                if (!activity.activity || typeof activity.activity.render !== 'function') return;
                var rendered = activity.activity.render();
                var container = rendered.find('.full-start-new__buttons').first();
                if (!container.length) container = rendered.find('.full-start__buttons').first();
                if (!container.length) return;

                // Идемпотентность: повторный full:complite (например, возврат
                // из Activity со списком серий) → убираем старую кнопку.
                container.find('.view--dlna').remove();

                var btn = buildButton(match, isSeries, card);
                container.prepend(btn);

                // Переиндексировать фокус в группе кнопок.
                try {
                    if (Lampa.Controller && Lampa.Controller.collectionSet) {
                        Lampa.Controller.collectionSet(rendered);
                    }
                } catch (e) {}
            } catch (e) {}
        }

        function refreshCurrent() {
            try {
                var active = Lampa.Activity.active();
                if (active && active.component === 'full') tryInject(active);
            } catch (e) {}
        }

        function init() {
            if (!window.Lampa || !Lampa.Listener) return;
            Lampa.Listener.follow('full', function (e) {
                if (e.type === 'complite') tryInject(e.object);
            });
            Lampa.Listener.follow('dlna_index', function (e) {
                if (e.type === 'ready' || e.type === 'updated') refreshCurrent();
            });
        }

        return { init: init, tryInject: tryInject, refreshCurrent: refreshCurrent };
    })();

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

    // Клиент Transmission RPC. Один POST torrent-add через serve.py.
    // На сборке Transmission в Кинетике CSRF отключен — обычно достаточно одного
    // запроса. Для совместимости со стандартным Transmission реализована fallback-
    // ветка на 409→retry с X-Transmission-Session-Id. Используем XHR, потому что
    // Lampa.Reguest не пробрасывает HTTP-статус и custom response-headers.
    var TransmissionClient = (function () {
        var sessionId = null;

        function rpcUrl() {
            var proxy = proxyBase();
            if (!proxy) return '';
            return proxy + 'http://' + trAddr() + '/transmission/rpc';
        }

        function basicAuthHeader() {
            var c = trCreds();
            if (!c.user || !c.pass) return null;  // basic-auth с пустым паролем
                                                  // ломает запрос на некоторых билдах
            return 'Basic ' + btoa(c.user + ':' + c.pass);
        }

        function buildBody(magnetOrUrl) {
            var args = { filename: magnetOrUrl };
            var dir = trDownloadDir();
            if (dir) args['download-dir'] = dir;
            return JSON.stringify({ method: 'torrent-add', arguments: args });
        }

        function send(magnetOrUrl, onDone, onFail) {
            var url = rpcUrl();
            if (!url) { onFail({ reason: 'no_proxy' }); return; }
            postOnce(url, magnetOrUrl, sessionId, function (status, sid, body) {
                if (status === 409 && sid && sid !== sessionId) {
                    sessionId = sid;
                    postOnce(url, magnetOrUrl, sessionId, function (s2, _, b2) {
                        handleFinal(s2, b2, onDone, onFail);
                    });
                    return;
                }
                handleFinal(status, body, onDone, onFail);
            });
        }

        function postOnce(url, magnetOrUrl, sid, cb) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            var auth = basicAuthHeader();
            if (auth) xhr.setRequestHeader('Authorization', auth);
            if (sid) xhr.setRequestHeader('X-Transmission-Session-Id', sid);
            xhr.timeout = 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                var sidFromResp = xhr.getResponseHeader('X-Transmission-Session-Id');
                cb(xhr.status, sidFromResp, xhr.responseText || '');
            };
            xhr.ontimeout = function () { cb(0, null, ''); };
            xhr.onerror = function () { cb(0, null, ''); };
            xhr.send(buildBody(magnetOrUrl));
        }

        function handleFinal(status, bodyText, onDone, onFail) {
            if (status === 401) { onFail({ reason: 'auth' }); return; }
            if (status === 0)   { onFail({ reason: 'network' }); return; }
            if (status === 403) { onFail({ reason: 'forbidden' }); return; }
            if (status >= 500)  { onFail({ reason: 'server', status: status }); return; }
            var data;
            try { data = JSON.parse(bodyText); }
            catch (e) { onFail({ reason: 'parse', body: bodyText }); return; }
            if (!data || data.result !== 'success') {
                onFail({ reason: 'rpc', message: data && data.result });
                return;
            }
            var added = data.arguments && data.arguments['torrent-added'];
            var dup   = data.arguments && data.arguments['torrent-duplicate'];
            if (added) { onDone({ added: true, name: added.name || '' }); return; }
            if (dup)   { onDone({ duplicate: true, name: dup.name || '' }); return; }
            onFail({ reason: 'empty_args' });
        }

        return {
            addTorrent: function (opts, onDone, onFail) {
                if (!opts || !opts.magnet) { onFail({ reason: 'no_magnet' }); return; }
                send(opts.magnet, onDone || function () {}, onFail || function () {});
            },
            // Для теста соединения из Settings: один POST session-stats
            ping: function (onDone, onFail) {
                var url = rpcUrl();
                if (!url) { onFail({ reason: 'no_proxy' }); return; }
                var xhr = new XMLHttpRequest();
                xhr.open('POST', url, true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                var auth = basicAuthHeader();
                if (auth) xhr.setRequestHeader('Authorization', auth);
                if (sessionId) xhr.setRequestHeader('X-Transmission-Session-Id', sessionId);
                xhr.timeout = 8000;
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;
                    var sid = xhr.getResponseHeader('X-Transmission-Session-Id');
                    if (xhr.status === 409 && sid) {
                        sessionId = sid;
                        return TransmissionClient.ping(onDone, onFail);
                    }
                    if (xhr.status === 401) { onFail({ reason: 'auth' }); return; }
                    if (xhr.status === 0)   { onFail({ reason: 'network' }); return; }
                    try {
                        var d = JSON.parse(xhr.responseText || '{}');
                        if (d.result === 'success') onDone(d.arguments || {});
                        else onFail({ reason: 'rpc', message: d.result });
                    } catch (e) { onFail({ reason: 'parse' }); }
                };
                xhr.ontimeout = function () { onFail({ reason: 'network' }); };
                xhr.onerror   = function () { onFail({ reason: 'network' }); };
                xhr.send(JSON.stringify({ method: 'session-stats' }));
            },
            _resetSession: function () { sessionId = null; }
        };
    })();

    // Последняя раздача, на которой пользователь сделал long-press в торрент-списке.
    // LAMPA-source шлёт Lampa.Listener.send('torrent', { type: 'onlong', element, ... })
    // прямо перед Select.show — мы запоминаем element и используем его при инжекте.
    var lastTorrentElement = null;

    function bindTorrentListener() {
        try {
            if (!window.Lampa || !Lampa.Listener || typeof Lampa.Listener.follow !== 'function') return;
            Lampa.Listener.follow('torrent', function (e) {
                if (!e) return;
                if (e.type === 'onlong' && e.element) {
                    lastTorrentElement = e.element;
                } else if (e.type === 'onenter' && e.element) {
                    lastTorrentElement = e.element;
                }
            });
        } catch (e) {}
    }

    // Извлечение magnet и человеко-читаемого имени из контекстного меню
    // торрент-раздачи. Структура items различается между online-источниками,
    // поэтому пробуем несколько fallback-стратегий. Возвращает strategy:
    // 'listener' | 'item-field' | 'item-regex' | 'dom-field' | 'dom-regex'
    // — для telemetry в debug Noty (понять что ломается при апдейте LAMPA).
    function extractTorrentInfo(params) {
        if (!params || !Array.isArray(params.items)) return null;
        var magnet = null;
        var strategy = null;
        var name = (params.title || '').toString();
        var seeds = 0;

        // Стратегия 0 (приоритет): сохранённый element из Lampa.Listener('torrent').
        // LAMPA-компонент torrents шлёт onlong-событие перед Select.show.
        if (lastTorrentElement) {
            var el = lastTorrentElement;
            var c = el.MagnetUri || el.Link || el.magnet || el.link;
            if (typeof c === 'string' && /^magnet:\?/.test(c)) {
                magnet = c; strategy = 'listener';
                if (typeof el.Title === 'string') name = el.Title;
                else if (typeof el.title === 'string') name = el.title;
                if (typeof el.Seeders === 'number') seeds = el.Seeders;
                else if (typeof el.seeds === 'number') seeds = el.seeds;
            }
        }

        // Стратегия 1: явное поле в каком-то item.
        if (!magnet) {
            for (var i = 0; i < params.items.length; i++) {
                var it = params.items[i] || {};
                var candidate = it.magnet || it.MagnetUri || it.link || it.url;
                if (typeof candidate === 'string' && /^magnet:\?/.test(candidate)) {
                    magnet = candidate; strategy = 'item-field'; break;
                }
                if (it._torrent && typeof it._torrent.magnet === 'string' && /^magnet:\?/.test(it._torrent.magnet)) {
                    magnet = it._torrent.magnet; strategy = 'item-field'; break;
                }
            }
        }

        // Стратегия 2: regex по текстам всех items + title.
        if (!magnet) {
            var blob = name + ' ' + JSON.stringify(params.items);
            var m = blob.match(/magnet:\?xt=urn:btih:[A-Fa-f0-9]+[^"\s]*/);
            if (m) { magnet = m[0]; strategy = 'item-regex'; }
        }

        // Стратегия 3: focused DOM-element торрент-раздачи. LAMPA-онлайн хранит
        // magnet в data(...) на самом .selector списка раздач, а context-меню
        // (Select.show) этого magnet не передаёт.
        if (!magnet && typeof $ !== 'undefined') {
            try {
                var focused = $('.selector.focus').last();
                if (focused.length) {
                    var data = (focused.data && focused.data()) || {};
                    var raw = focused[0];
                    // Пробуем data-fields, потом raw DOM-property (LAMPA иногда
                    // вешает объект прямо на element[0].torrent).
                    var candidates = [
                        data.torrent, data.item, data.element, data.card,
                        raw && raw.torrent, raw && raw.item, raw && raw.element
                    ];
                    for (var ci = 0; ci < candidates.length; ci++) {
                        var c = candidates[ci];
                        if (!c || typeof c !== 'object') continue;
                        var fields = [c.magnet, c.MagnetUri, c.Link, c.link, c.url, c.torrent_url];
                        for (var fi = 0; fi < fields.length; fi++) {
                            if (typeof fields[fi] === 'string' && /^magnet:\?/.test(fields[fi])) {
                                magnet = fields[fi]; strategy = 'dom-field';
                                if (typeof c.Title === 'string')   name = c.Title;
                                else if (typeof c.title === 'string') name = c.title;
                                if (typeof c.Seeders === 'number')  seeds = c.Seeders;
                                else if (typeof c.seeds === 'number') seeds = c.seeds;
                                break;
                            }
                        }
                        if (magnet) break;
                    }
                    // Самый общий fallback — JSON.stringify(focused data) + regex.
                    if (!magnet) {
                        try {
                            var allBlob = JSON.stringify(data) + ' ' + JSON.stringify({
                                t: raw && raw.torrent, i: raw && raw.item
                            });
                            var mf = allBlob.match(/magnet:\?xt=urn:btih:[A-Fa-f0-9]+[^"\s]*/);
                            if (mf) { magnet = mf[0]; strategy = 'dom-regex'; }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }

        if (!magnet) return null;

        // Сиды — best-effort, для subtitle.
        var seedsMatch = JSON.stringify(params.items).match(/"?seeds"?\s*:\s*(\d+)/i);
        if (seedsMatch) seeds = parseInt(seedsMatch[1], 10);

        return { magnet: magnet, name: name || 'торрент', seeds: seeds, strategy: strategy };
    }

    // Override Lampa.Select.show для инжекта «Скачать на Кинетик» в context-меню
    // торрент-раздачи. try/catch гарантирует что override никогда не ломает
    // нативное поведение LAMPA.
    var TransmissionAddon = (function () {
        var TORRENT_COMPONENTS = ['torrents', 'online', 'lampac_online'];
        var installed = false;

        function isDebug() {
            try { return !!Lampa.Storage.field('transmission_debug'); }
            catch (e) { return false; }
        }

        function isTorrentContext() {
            try {
                var a = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
                if (!a || !a.component) return false;
                return TORRENT_COMPONENTS.indexOf(a.component) >= 0;
            } catch (e) { return false; }
        }

        function debugReport(params) {
            try {
                var a = (Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active()) || {};
                var comp = a.component || 'unknown';
                var items = (params && params.items) || [];
                var info = extractTorrentInfo(params || {});
                var msg = '[t-debug] comp=' + comp + ' items=' + items.length +
                          ' magnet=' + (info ? 'YES' : 'NO') +
                          (info && info.strategy ? ' via=' + info.strategy : '');
                console.warn(msg, { params: params, activity: a });
                if (Lampa.Noty) Lampa.Noty.show(msg);

                // Дамп фокусного DOM-элемента: какие ключи доступны и есть ли
                // там что-то похожее на magnet — для подбора стратегии extract.
                try {
                    var focused = (typeof $ !== 'undefined') ? $('.selector.focus').last() : null;
                    if (focused && focused.length) {
                        var data = (focused.data && focused.data()) || {};
                        var keys = Object.keys(data);
                        var raw = focused[0] || {};
                        var rawKeys = [];
                        if (raw.torrent) rawKeys.push('raw.torrent');
                        if (raw.item)    rawKeys.push('raw.item');
                        if (raw.element) rawKeys.push('raw.element');
                        var snapshot = JSON.stringify(data).slice(0, 200);
                        var hasMagnet = /magnet:\?xt=urn:btih:/i.test(snapshot);
                        var dmsg = '[t-debug] focused data=[' + keys.join(',') + ']' +
                                   (rawKeys.length ? ' rawProps=[' + rawKeys.join(',') + ']' : '') +
                                   ' hasMagnet=' + (hasMagnet ? 'YES' : 'NO');
                        console.warn(dmsg, { focusedData: data, raw: raw });
                        if (Lampa.Noty) Lampa.Noty.show(dmsg);
                    } else if (Lampa.Noty) {
                        Lampa.Noty.show('[t-debug] focused: not found');
                    }
                } catch (e2) {
                    try { console.warn('[t-debug] focused-dump failed', e2); } catch (_) {}
                }
            } catch (e) {
                try { console.warn('[t-debug] report failed', e); } catch (_) {}
            }
        }

        function makeItem(info) {
            return {
                title: 'Скачать на Кинетик',
                subtitle: (info.seeds ? info.seeds + ' сидов · ' : '') + 'отправить в Transmission',
                _kt_send: true,
                _kt_info: info
            };
        }

        function send(info) {
            Lampa.Noty.show('Отправляю в Transmission…');
            TransmissionClient.addTorrent({ magnet: info.magnet, name: info.name },
                function (res) {
                    var label = res.name || info.name || '';
                    if (res.duplicate) Lampa.Noty.show('Уже в очереди: ' + label);
                    else                Lampa.Noty.show('Добавлено: ' + label);
                },
                function (err) {
                    var msg;
                    switch (err.reason) {
                        case 'auth':      msg = 'Неверный логин/пароль Transmission'; break;
                        case 'network':   msg = 'Прокси/RPC недоступен. Проверь serve.py и адрес RPC.'; break;
                        case 'forbidden': msg = 'Прокси: хост не в allowlist (DLNA_PROXY_ALLOW)'; break;
                        case 'no_magnet': msg = 'Не удалось определить magnet'; break;
                        case 'no_proxy':  msg = 'Не задан Прокси URL'; break;
                        case 'rpc':       msg = 'Transmission: ' + (err.message || 'ошибка'); break;
                        case 'parse':     msg = 'Некорректный ответ Transmission'; break;
                        default:          msg = 'Ошибка: ' + (err.reason || 'неизвестно');
                    }
                    if (isDebug()) console.warn('[transmission]', err);
                    Lampa.Noty.show(msg);
                });
        }

        function wrap(params) {
            try {
                if (isDebug()) debugReport(params);
                if (!isTorrentContext()) return params;
                var info = extractTorrentInfo(params);
                if (!info) return params;
                // Идемпотентность: вдруг Select.show вызывается повторно с теми же
                // items (например после возврата фокуса).
                var already = params.items && params.items.length && params.items[0]._kt_send;
                if (already) return params;
                var item = makeItem(info);
                params.items = [item].concat(params.items || []);
                var origOnSelect = params.onSelect;
                params.onSelect = function (selected) {
                    if (selected && selected._kt_send) {
                        send(selected._kt_info);
                        return;
                    }
                    if (typeof origOnSelect === 'function') origOnSelect.apply(this, arguments);
                };
                return params;
            } catch (e) {
                if (isDebug()) console.warn('[transmission] wrap failed', e);
                return params;
            }
        }

        function install() {
            if (installed) return;
            if (!window.Lampa || !Lampa.Select || typeof Lampa.Select.show !== 'function') return;
            var orig = Lampa.Select.show;
            Lampa.Select.show = function (params) {
                return orig.call(this, wrap(params));
            };
            installed = true;
        }

        return { install: install, _wrap: wrap, _extract: extractTorrentInfo };
    })();

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
        Lampa.Component.add('keenetic_dlna_episodes', EpisodeListComponent);
        registerSettings();

        function registerSettings() {
            if (!Lampa.SettingsApi) return;
            Lampa.SettingsApi.addComponent({
                component: 'keenetic_dlna',
                name: 'Keenetic DLNA v' + PLUGIN_VERSION,
                icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><polygon points="10 9 16 12 10 15" fill="currentColor"/></svg>'
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_DLNA_ADDR, type: 'input', placeholder: '192.168.1.1:8200', values: '', default: DEFAULT_DLNA_ADDR },
                field: { name: 'Адрес DLNA-сервера', description: 'Плагин v' + PLUGIN_VERSION + '. IP:порт MiniDLNA на Кинетике. По умолчанию 192.168.1.1:8200.' },
                onChange: function () {
                    // Адрес сменился — кеш index не валиден, тянем заново.
                    try { Lampa.Storage.set(ALL_VIDEO_ID_KEY, ''); } catch (e) {}
                    try { IndexService.refresh({ full: true }); } catch (e) {}
                }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_DLNA_PROXY, type: 'input', placeholder: DEFAULT_DLNA_PROXY, values: '', default: DEFAULT_DLNA_PROXY },
                field: {
                    name: 'Прокси URL',
                    description: 'HTTP(S)-прокси для обхода CORS preflight. По дефолту — прокси из install.sh на самом Кинетике. См. README.'
                }
            });
            // Кнопка ручного refresh. Спек называет тип 'button', но в
            // LAMPA-source я не нашел его в hard-coded списке типов
            // params — используем trigger с default=false и сбрасываем
            // флаг в onChange (стандартный паттерн для триггерных
            // действий, видел в других плагинах).
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: 'dlna_refresh_index', type: 'trigger', default: false },
                field: {
                    name: 'Обновить DLNA-индекс',
                    description: 'Пересканировать DLNA и обновить кеш совпадений с TMDB'
                },
                onChange: function () {
                    try { Lampa.Storage.set('dlna_refresh_index', false); } catch (e) {}
                    try { Lampa.Storage.set(ALL_VIDEO_ID_KEY, ''); } catch (e) {}
                    try { IndexService.refresh({ full: true }); } catch (e) {}
                    if (window.Lampa && Lampa.Noty) Lampa.Noty.show('DLNA: обновление индекса запущено');
                }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_ADDR, type: 'input', placeholder: DEFAULT_TR_ADDR, values: '', default: DEFAULT_TR_ADDR },
                field: {
                    name: 'Transmission RPC',
                    description: 'IP:порт RPC встроенного Transmission Кинетика. По умолчанию 8090; если в web-UI Кинетика порт другой — задай вручную.'
                },
                onChange: function () { try { TransmissionClient._resetSession(); } catch (e) {} }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_USER, type: 'input', placeholder: DEFAULT_TR_USER, values: '', default: DEFAULT_TR_USER },
                field: { name: 'Пользователь Transmission', description: 'Логин из web-UI Кинетика → Transmission.' },
                onChange: function () { try { TransmissionClient._resetSession(); } catch (e) {} }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_PASS, type: 'input', placeholder: '', values: '', default: '' },
                field: {
                    name: 'Пароль Transmission',
                    description: 'Пароль из web-UI Кинетика. Хранится в LAMPA в открытом виде — не используй критичные пароли. Если пустой — basic-auth не отправляется.'
                },
                onChange: function () { try { TransmissionClient._resetSession(); } catch (e) {} }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_DIR, type: 'input', placeholder: '', values: '', default: '' },
                field: {
                    name: 'Папка скачивания (опц.)',
                    description: 'Если пусто — Transmission кладет в свою default-папку, заданную в web-UI Кинетика. Если задано — передается как download-dir.'
                }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: STORAGE_TR_TEST, type: 'trigger', default: false },
                field: {
                    name: 'Тест соединения с Transmission',
                    description: 'session-stats → Noty с результатом.'
                },
                onChange: function () {
                    try { Lampa.Storage.set(STORAGE_TR_TEST, false); } catch (e) {}
                    if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Проверяю Transmission…');
                    TransmissionClient.ping(
                        function (info) {
                            var n = info.torrentCount;
                            Lampa.Noty.show('Transmission OK · торрентов: ' + (typeof n === 'number' ? n : '?'));
                        },
                        function (err) {
                            var msg;
                            switch (err.reason) {
                                case 'auth':    msg = 'Неверный логин/пароль'; break;
                                case 'network': msg = 'Не достучался до RPC'; break;
                                case 'rpc':     msg = 'RPC: ' + (err.message || 'ошибка'); break;
                                default:        msg = 'Ошибка: ' + (err.reason || 'неизвестно');
                            }
                            Lampa.Noty.show(msg);
                        });
                }
            });
            Lampa.SettingsApi.addParam({
                component: 'keenetic_dlna',
                param: { name: 'transmission_debug', type: 'trigger', default: false },
                field: {
                    name: 'Debug Transmission',
                    description: 'Показывать Noty при каждом Select.show с component-именем и наличием magnet. Для диагностики — обычно выключено.'
                }
            });
        }

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

        function bootIndex() {
            // Warm: моментально из Storage; cold-quickCheck отложен,
            // чтобы не конкурировать со стартом LAMPA.
            try { IndexService.load(); } catch (e) {}
            try { CardButton.init(); } catch (e) {}
            try { TransmissionAddon.install(); } catch (e) {}
            try { bindTorrentListener(); } catch (e) {}
            setTimeout(function () {
                try { IndexService.quickCheck(); } catch (e) {}
                try { TransmissionAddon.install(); } catch (e) {}  // retry если Lampa.Select не был готов
            }, 2000);
        }

        if (window.appready) { addMenu(); bootIndex(); }
        else Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') { addMenu(); bootIndex(); }
        });

        Lampa.Manifest.plugins = manifest;
    }

    startPlugin();
})();
