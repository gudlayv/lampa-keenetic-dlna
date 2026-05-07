#!/usr/bin/env node
/**
 * tools/browse.js — открывает LAMPA web в headless Chromium через Playwright,
 * инжектит локальный плагин и снимает скриншот.
 *
 * Использование:
 *   node tools/browse.js [--url URL] [--plugin PATH] [--out PATH] [--wait MS] [--headed]
 *
 * Дефолты:
 *   --url     http://lampa.mx/?title=Keenetic%20DLNA&component=keenetic_dlna&page=1
 *   --plugin  plugins/dlna.js
 *   --out     shots/lampa-<timestamp>.png
 *   --wait    4000  (после inject — даем TMDB/SOAP отработать)
 *
 * Логирует console-сообщения и pageerror'ы.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--headed') { args.headed = true; continue; }
        if (a.startsWith('--')) {
            args[a.slice(2)] = argv[++i];
        }
    }
    return args;
}

(async () => {
    const args = parseArgs(process.argv);
    const url = args.url || 'http://lampa.mx/?title=Keenetic%20DLNA&component=keenetic_dlna&page=1';
    const pluginPath = args.plugin || path.join(__dirname, '..', 'plugins', 'dlna.js');
    const outDir = path.join(__dirname, '..', 'shots');
    fs.mkdirSync(outDir, { recursive: true });
    const out = args.out || path.join(outDir, 'lampa-' + Date.now() + '.png');
    const waitMs = parseInt(args.wait || '4000', 10);

    const browser = await chromium.launch({ headless: !args.headed });
    const ctx = await browser.newContext({
        viewport: { width: 1600, height: 900 },
        deviceScaleFactor: 1,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    // Пропускаем мастер выбора языка — LAMPA проверяет localStorage.language до запуска
    await ctx.addInitScript(() => {
        try {
            window.localStorage.setItem('language', 'ru');
            window.localStorage.setItem('tmdb_lang', 'ru');
        } catch (e) {}
    });
    const page = await ctx.newPage();

    page.on('console', msg => console.log('[' + msg.type() + ']', msg.text()));
    page.on('pageerror', err => console.error('[pageerror]', err.message));
    page.on('requestfailed', req => console.warn('[requestfailed]', req.url(), '-', req.failure() && req.failure().errorText));

    console.log('goto', url);
    try {
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    } catch (e) {
        console.warn('goto warning:', e.message);
    }

    console.log('wait for window.Lampa…');
    try {
        await page.waitForFunction(() => !!window.Lampa, null, { timeout: 30000 });
    } catch (e) {
        console.error('Lampa global not appeared:', e.message);
    }

    console.log('inject plugin', pluginPath);
    const code = fs.readFileSync(pluginPath, 'utf-8');
    await page.addScriptTag({ content: code });

    // Программно открываем нашу активити уже после регистрации компонента
    const navTo = args.component;
    if (navTo) {
        console.log('Activity.push component=' + navTo);
        await page.evaluate((c) => {
            try {
                if (window.Lampa && Lampa.Activity) {
                    Lampa.Activity.push({ url: '', title: c, component: c, page: 1 });
                }
            } catch (e) { console.error('activity.push failed:', e.message); }
        }, navTo);
    }

    console.log('wait', waitMs, 'ms…');
    await page.waitForTimeout(waitMs);

    // Опция --keys "down,down,down,enter" — симулирует клавиши пульта для перехода
    if (args.keys) {
        const keyMap = { down: 'ArrowDown', up: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight', enter: 'Enter', back: 'Backspace', esc: 'Escape' };
        const sequence = args.keys.split(',').map(s => s.trim()).filter(Boolean);
        for (const k of sequence) {
            const key = keyMap[k.toLowerCase()] || k;
            console.log('key', key);
            await page.keyboard.press(key);
            await page.waitForTimeout(800);
        }
        // дополнительная пауза для финального async-рендера
        await page.waitForTimeout(2500);
    }

    console.log('shot', out);
    await page.screenshot({ path: out, fullPage: true });

    // dumpHtml — короткая выжимка корня компонента
    try {
        const dump = await page.evaluate(() => {
            const node = document.querySelector('.dlna-keenetic') || document.querySelector('.activity__body');
            if (!node) return '<no body>';
            return node.outerHTML.slice(0, 4000);
        });
        const dumpPath = out.replace(/\.png$/, '.html');
        fs.writeFileSync(dumpPath, dump);
        console.log('dump', dumpPath);
    } catch (e) {
        console.warn('dump failed:', e.message);
    }

    await browser.close();
    console.log('done');
})();
