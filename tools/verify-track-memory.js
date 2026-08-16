#!/usr/bin/env node
/**
 * tools/verify-track-memory.js — юнит-тест сопоставления сохраненного
 * выбора дорожки со списком дорожек меню (matchSavedTrack из dlna.js).
 * Извлечение pure-функции — brace-matching + eval, как verify-parser.js.
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
eval(extract('matchSavedTrack'));

let failed = 0;
function ok(cond, msg) { if (!cond) { console.error('  ❌', msg); failed++; } else console.log('  ✅', msg); }

const tracks = [
    { index: 3, language: 'eng', label: 'Original' },
    { index: 5, language: 'rus', label: 'LostFilm' },
    { index: 7, language: 'rus', label: 'HDRezka' },
    { index: 11, language: '', label: '' }
];

console.log('Проверка matchSavedTrack:');
ok(matchSavedTrack({ label: 'HDRezka', language: 'rus', index: 1 }, tracks) === 2, 'точный label важнее language и index');
ok(matchSavedTrack({ label: 'Кубик в кубе', language: 'rus', index: 5 }, tracks) === 1, 'нет label-матча → первый матч по language');
ok(matchSavedTrack({ label: 'Кубик в кубе', language: 'ukr', index: 7 }, tracks) === 2, 'нет label/language → фолбэк по index (поле index, не позиция)');
ok(matchSavedTrack({ label: 'Кубик в кубе', language: 'ukr', index: 9 }, tracks) === null, 'ничего не совпало → null');
ok(matchSavedTrack({ label: '', language: '', index: 3 }, tracks) === 0, 'пустые label/language не матчатся, index работает');
ok(matchSavedTrack(null, tracks) === null, 'null-выбор → null');
ok(matchSavedTrack({ label: 'LostFilm' }, []) === null, 'пустой список дорожек → null');
ok(matchSavedTrack({ label: '', language: '', index: 7 }, tracks) === 2, 'пустой label дорожки в фикстуре не перехватывает матч раньше index-фолбэка');

if (failed) { console.error('\nРЕГРЕСС: ' + failed + ' проверок упало.'); process.exit(1); }
console.log('Все проверки пройдены.');
