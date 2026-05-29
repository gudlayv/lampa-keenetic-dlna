#!/usr/bin/env node
/**
 * tools/verify-parser.js — регресс-тест парсера индекса (folder-tree модель).
 *
 * Извлекает РЕАЛЬНЫЕ pure-функции из plugins/dlna.js (cleanFolderTitle,
 * strictPrefix, episodeNum, normKey, ...) и прогоняет логику классификации
 * buildFromTitleUnits против ФИКСТУРЫ из репрезентативных имён файлов
 * (реальные кейсы с диска: файлы без префикса шоу, "NN серия", номер перед
 * release-тегом, варианты написания). Не зависит от живого DLNA/диска.
 *
 * Запуск:  node tools/verify-parser.js   (exit 0 = ok, 1 = регресс)
 *
 * Зачем: имя шоу должно браться из ПАПКИ, не из имени файла. Иначе серии без
 * префикса плодят фантомные карточки ("Raid", "Lakeshore Limited", ...).
 */
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'dlna.js'), 'utf8');
const VIDEO = /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i;

// --- вырезаем нужные объявления из плагина по имени (brace-matching) ---
function extract(name, kind) {
    const re = new RegExp((kind === 'var' ? 'var ' : 'function ') + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const i = SRC.search(re);
    if (i < 0) throw new Error('not found in dlna.js: ' + name);
    if (kind === 'var') { const semi = SRC.indexOf(';', i); return SRC.slice(i, semi + 1); }
    let j = SRC.indexOf('{', i), depth = 0, k = j;
    for (; k < SRC.length; k++) { if (SRC[k] === '{') depth++; else if (SRC[k] === '}') { depth--; if (depth === 0) { k++; break; } } }
    return SRC.slice(i, k);
}
eval([
    extract('FOLDER_CUT', 'var'), extract('FOLDER_SEASON', 'var'),
    extract('cleanShow'), extract('parseFilename'),
    extract('normKey'), extract('strictPrefix'), extract('cleanFolderTitle'),
    extract('folderSeason'), extract('episodeNum'), extract('episodeSeasonFromFile')
].join('\n'));

// --- фикстура: { folderName: [files...] } + standalone files ---
function range(n, fn) { return Array.from({ length: n }, (_, i) => fn(i + 1)); }
const FOLDERS = {
    // файлы БЕЗ префикса шоу — имя эпизода НЕ должно стать именем шоу
    'Common.Side.Effects.S01.1080p.Rus.Eng': [
        'S01E01 Pilot.mkv', 'S01E02 Lakeshore Limited.mkv', 'S01E03 Hildy.mkv',
        'S01E04 Dumpsite.mkv', 'S01E05 Star-Tel-Lite.mkv', 'S01E06 In The System.mkv',
        'S01E07 Blowfish.mkv', 'S01E08 Amelia & Wyatt.mkv', 'S01E09 Cliff\'s Edge.mkv', 'S01E10 Raid.mkv'
    ],
    // вариации написания одного шоу в разных сезонных папках → одна карточка
    'Marvel\'s.Daredevil.S02.2160p.DSNP.WEB-DL.HEVC.Hybrid.DV.HDR': range(3, n => `Marvel's Daredevil S02E0${n} Title.mkv`),
    'Marvels.Daredevil.S03.1080p.NewStudio.(Wanterlude)': range(3, n => `Marvels.Daredevil.S03E0${n}.Title.1080p.NewStudio.(Wanterlude).mkv`),
    // "NN серия" без SxxExx
    'Обреченные на славу (2024)': range(3, n => `0${n} серия.mkv`),
    // номер серии перед release-тегом
    'Парадокс убийцы': range(3, n => `Парадокс убийцы ${n}.WEB-DLRip.avi`),
    // билингва-папка, но файлы с чистым префиксом → имя из файла
    'Когда жизнь даёт тебе мандарины  When Life Gives You Tangerines S01 (2025) 1080p': range(2, n => `When.Life.Gives.You.Tangerines.S01E0${n}.2025.1080p.NF.mkv`),
    'Alice in Borderland (Season 3) WEB-DL 1080p': range(2, n => `Alice.in.Borderland.S03E0${n}.1080p.WEB-DL.mkv`)
};
const FILES = ['Apex.2026.2160p.NF.WEB-DL.mkv', 'The.Devil.Wears.Prada.2006.2160p.WEB-DL.mkv'];

// --- зеркало buildFromTitleUnits ---
const shows = {}, movies = [];
function addEp(show, season, ep) {
    const k = normKey(show);
    if (!k) { movies.push(parseFilename(show || '?').title); return; }
    if (!shows[k]) shows[k] = { show, seasons: {} };
    shows[k].seasons[season] = (shows[k].seasons[season] || 0) + 1;
}
Object.keys(FOLDERS).forEach(folder => {
    const files = FOLDERS[folder].map(t => ({ title: t }));
    const folderTitle = cleanFolderTitle(folder), fSeason = folderSeason(folder);
    const seriesLike = files.length > 1 || files.some(f => /S\d{1,2}[._\s\-]?E\d{1,3}|сери|\d{1,2}x\d{1,3}/i.test(f.title));
    if (!seriesLike) { movies.push(parseFilename(folder).title); return; }
    files.slice().sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true })).forEach((f, i) => {
        const sp = strictPrefix(f.title);
        if (sp && sp.show) addEp(sp.show, sp.season, sp.episode);
        else { let ep = episodeNum(f.title); if (ep == null) ep = i + 1; addEp(folderTitle, episodeSeasonFromFile(f.title) || fSeason || 1, ep); }
    });
});
FILES.forEach(f => movies.push(parseFilename(f).title));

// --- ассерты ---
let failed = 0;
function ok(cond, msg) { if (!cond) { console.error('  ❌', msg); failed++; } else console.log('  ✅', msg); }
const byTitle = {}; Object.values(shows).forEach(s => byTitle[normKey(s.show)] = s);
function show(name) { return byTitle[normKey(name)]; }

console.log('Проверка парсера (folder-tree):');
const PHANTOMS = ['Raid', 'Pilot', 'Lakeshore Limited', 'Dumpsite', 'Hildy', 'Star-Tel-Lite', 'In The System', 'Blowfish', 'Amelia', 'Cliff'];
ok(!PHANTOMS.some(p => show(p)), 'нет фантом-шоу из имён эпизодов (Raid/Pilot/Lakeshore/...)');
ok(show('Common Side Effects') && show('Common Side Effects').seasons[1] === 10, 'Common Side Effects → 1 шоу, сезон 1 = 10 серий');
const dd = show('Marvel\'s Daredevil') || show('Marvels Daredevil');
ok(dd && dd.seasons[2] === 3 && dd.seasons[3] === 3, 'Daredevil S02+S03 слиты в одну карточку (нормализация ключа)');
ok(show('Обреченные на славу') && show('Обреченные на славу').seasons[1] === 3, '"NN серия" → шоу "Обреченные на славу" (не фильмы)');
ok(show('Парадокс убийцы') && show('Парадокс убийцы').seasons[1] === 3, '"Show N.release" → шоу "Парадокс убийцы" (не фильмы)');
ok(show('When Life Gives You Tangerines'), 'билингва-папка → имя из префикса файла');
ok(show('Alice in Borderland') && show('Alice in Borderland').seasons[3] === 2, 'Alice in Borderland сезон 3');
ok(movies.indexOf('Apex') >= 0, 'standalone-файл Apex → фильм');
ok(!movies.some(m => /серия|Парадокс/.test(m)), 'серии не утекли в фильмы');
ok(movies.length === 2, 'ровно 2 фильма (Apex, Prada 2006), got ' + movies.length);

console.log('\nИтог: ' + Object.keys(shows).length + ' шоу, ' + movies.length + ' фильмов.');
if (failed) { console.error('\nРЕГРЕСС: ' + failed + ' проверок упало.'); process.exit(1); }
console.log('Все проверки пройдены.');
