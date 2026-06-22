#!/usr/bin/env node
/**
 * tools/verify-torrent-match.js — юнит-тест матчера DLNA-файл → торрент.
 * Извлекает pure-функции normTorrentName / findTorrentForFile из dlna.js
 * (brace-matching + eval, как verify-parser.js). Не зависит от живого RPC.
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
eval([extract('normTorrentName'), extract('findTorrentForFile')].join('\n'));

let failed = 0;
function ok(cond, msg) { if (!cond) { console.error('  ❌', msg); failed++; } else console.log('  ✅', msg); }

const list = [
    { id: 11, name: 'Apex.2026.2160p.NF.WEB-DL', files: [{ name: 'Apex.2026.2160p.NF.WEB-DL.mkv' }] },
    { id: 12, name: 'The.Devil.Wears.Prada.2006.2160p.WEB-DL', files: [{ name: 'The.Devil.Wears.Prada.2006.2160p.WEB-DL.mkv' }] },
    { id: 13, name: 'Common.Side.Effects.S01', files: [{ name: 'S01E01 Pilot.mkv' }, { name: 'S01E02 Lakeshore Limited.mkv' }] }
];

console.log('Проверка findTorrentForFile:');
ok(findTorrentForFile('Apex.2026.2160p.NF.WEB-DL.mkv', list).id === 11, 'точный матч по files[].name (Apex)');
ok(findTorrentForFile('The Devil Wears Prada', list).id === 12, 'матч по подстроке имени раздачи (Prada)');
ok(findTorrentForFile('S01E02 Lakeshore Limited.mkv', list).id === 13, 'матч серии по files[].name');
ok(findTorrentForFile('Совершенно.Другой.Фильм.2099.mkv', list) === null, 'нет ложного матча на чужой файл');
ok(findTorrentForFile('', list) === null, 'пустой ввод → null');
ok(findTorrentForFile('a.mkv', list) === null, 'слишком короткое имя → null (без ложного)');

if (failed) { console.error('\nРЕГРЕСС: ' + failed + ' проверок упало.'); process.exit(1); }
console.log('Все проверки пройдены.');
