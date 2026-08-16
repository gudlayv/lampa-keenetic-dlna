#!/usr/bin/env node
/**
 * tools/verify-show-delete.js — юнит-тест агрегатора раздач сериала
 * (findTorrentsForShow из dlna.js). Извлечение pure-функций —
 * brace-matching + eval, как verify-parser.js.
 */
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'dlna.js'), 'utf8');

function extract(name) {
    const re = new RegExp('function ' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const i = SRC.search(re);
    if (i < 0) throw new Error('not found in dlna.js: ' + name);
    let j = SRC.indexOf('{', i), depth = 0, k = j;
    for (; k < SRC.length; k++) { if (SRC[k] === '{') depth++; else if (SRC[k] === '}') { depth--; if (depth === 0) { k++; break; } } }
    return SRC.slice(i, k);
}
eval([extract('normTorrentName'), extract('findTorrentForFile'), extract('findTorrentsForShow')].join('\n'));

let failed = 0;
function ok(cond, msg) { if (!cond) { console.error('  ❌', msg); failed++; } else console.log('  ✅', msg); }

const list = [
    { id: 21, name: 'Common.Side.Effects.S01', files: [{ name: 'S01E01 Pilot.mkv' }, { name: 'S01E02 Lakeshore Limited.mkv' }] },
    { id: 22, name: 'Common.Side.Effects.S02', files: [{ name: 'Common.Side.Effects.S02E01.mkv' }] },
    { id: 23, name: 'Some.Movie.2020', files: [{ name: 'Some.Movie.2020.mkv' }] }
];
const show = { seasons: [
    { season: 1, episodes: [{ title: 'S01E01 Pilot.mkv' }, { title: 'S01E02 Lakeshore Limited.mkv' }] },
    { season: 2, episodes: [{ title: 'Common.Side.Effects.S02E01.mkv' }, { title: 'Common.Side.Effects.S02E02.mkv' }] }
] };

console.log('Проверка findTorrentsForShow:');
const r = findTorrentsForShow(show, list);
ok(r.torrents.length === 2, 'сезон-пак дедуплицирован: 3 матч-серии → 2 раздачи');
ok(r.torrents.some(t => t.id === 21) && r.torrents.some(t => t.id === 22), 'найдены обе раздачи сезонов (21, 22)');
ok(!r.torrents.some(t => t.id === 23), 'чужая раздача (фильм) не зацеплена');
ok(r.matchedEpisodes === 3, 'покрыто 3 серии (S02E02 без раздачи)');
ok(r.totalEpisodes === 4, 'всего 4 серии');
const empty = findTorrentsForShow(show, []);
ok(empty.torrents.length === 0 && empty.totalEpisodes === 4, 'пустой список Transmission → 0 раздач');
const none = findTorrentsForShow(null, list);
ok(none.torrents.length === 0 && none.totalEpisodes === 0, 'нет сериала → пустой результат без падения');

if (failed) { console.error('\nРЕГРЕСС: ' + failed + ' проверок упало.'); process.exit(1); }
console.log('Все проверки пройдены.');
