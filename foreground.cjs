'use strict';

// 前台窗口探测：判断「现在屏幕上的前台程序是不是全屏」。
//
// 做法是借用 Folia 自带的 koffi（一个允许 Node 直接调 C 接口的库）去调 user32，
// 拿到前台窗口句柄、类名和矩形，再和屏幕尺寸比对。
// 之所以不用 Electron 自带 API：Electron 不暴露「当前前台窗口」这个信息。

const path = require('path');

const RESULTS = {
    loaded: false,
    reason: '',
};

function loadKoffi() {
    // 宿主可能已经加载过 koffi，直接复用最省事
    for (const key of Object.keys(require.cache)) {
        if (!/koffi/.test(key)) continue;
        const cached = require.cache[key] && require.cache[key].exports;
        if (cached && typeof cached.load === 'function') {
            RESULTS.loaded = true;
            RESULTS.reason = `已加载：${key}`;
            return cached;
        }
    }

    const resourcesRoot =
        process.resourcesPath || path.join(path.dirname(process.execPath || ''), 'resources');
    const candidates = [
        // 打包后的原生模块在 app.asar.unpacked 里
        path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'),
        path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@koromix', 'koffi-win32-x64'),
        path.join(resourcesRoot, 'app.asar', 'node_modules', 'koffi'),
        'koffi',
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            const mod = require(candidate);
            const api = mod && mod.load ? mod : mod && mod.default;
            if (api && typeof api.load === 'function') {
                RESULTS.loaded = true;
                RESULTS.reason = candidate;
                return api;
            }
        } catch (error) {
            RESULTS.reason = `${candidate} -> ${error.message}`;
        }
    }
    return null;
}

const toNumber = (value) => {
    if (typeof value === 'bigint') return Number(value);
    return Number(value || 0);
};

function createForegroundProbe(log) {
    const koffi = loadKoffi();
    if (!koffi) {
        log.warn('全屏检测不可用（未找到 koffi）：', RESULTS.reason);
        return null;
    }
    log.info('全屏检测已启用，koffi 来自：', RESULTS.reason);

    const { screen } = require('electron');
    const user32 = koffi.load('user32.dll');

    const RECT = koffi.struct('TaskbarBarRect', {
        left: 'int32',
        top: 'int32',
        right: 'int32',
        bottom: 'int32',
    });

    const GetForegroundWindow = user32.func('GetForegroundWindow', 'intptr', []);
    const GetShellWindow = user32.func('GetShellWindow', 'intptr', []);
    const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['intptr']);
    const GetWindowRect = user32.func('GetWindowRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]);
    const GetClassNameW = user32.func('GetClassNameW', 'int', ['intptr', koffi.out(koffi.pointer('char16_t')), 'int']);
    const GetWindowTextW = user32.func('GetWindowTextW', 'int', ['intptr', koffi.out(koffi.pointer('char16_t')), 'int']);

    const buffer = Buffer.alloc(2048);
    const readText = (fn, hwnd) => {
        try {
            const len = fn(hwnd, buffer, 1024);
            if (!len || len <= 0) return '';
            return buffer.toString('utf16le', 0, len * 2);
        } catch (error) {
            return '';
        }
    };

    // 这些类名不是「用户在用的全屏程序」，不该触发隐藏控制条
    const IGNORED_CLASSES = new Set([
        'Progman',
        'WorkerW',
        'Shell_TrayWnd',
        'Shell_SecondaryTrayWnd',
        'ForegroundStaging',
        'tooltips_class32',
        'DV2ControlHost',
    ]);

    // 允许 2px 误差（有些程序全屏时会把高度算成 1439 之类）
    const TOLERANCE = 3;

    const coversDisplay = (rect, bounds) =>
        rect.left <= bounds.x + TOLERANCE &&
        rect.top <= bounds.y + TOLERANCE &&
        rect.right >= bounds.x + bounds.width - TOLERANCE &&
        rect.bottom >= bounds.y + bounds.height - TOLERANCE;

    return {
        // ownHwnds：我们自己的窗口，点到控制条时它会成为前台，不能算全屏
        isFullscreenForeground(ownHwnds) {
            const fg = toNumber(GetForegroundWindow());
            if (!fg) return false;
            if (ownHwnds.some((hwnd) => hwnd && hwnd === fg)) return false;
            if (fg === toNumber(GetShellWindow())) return false;
            try {
                if (!IsWindowVisible(fg)) return false;
            } catch (error) {
                return false;
            }

            const className = readText(GetClassNameW, fg);
            if (IGNORED_CLASSES.has(className)) return false;
            // Windows 输入法/触摸键盘宿主也是全屏 CoreWindow，别误判
            if (className === 'Windows.UI.Core.CoreWindow') {
                const title = readText(GetWindowTextW, fg);
                if (title && (title.includes('输入体验') || title.includes('Input'))) return false;
            }

            const rect = {};
            try {
                if (!GetWindowRect(fg, rect)) return false;
            } catch (error) {
                return false;
            }

            let displays = [];
            try {
                displays = screen.getAllDisplays();
            } catch (error) {
                return false;
            }
            return displays.some((display) => coversDisplay(rect, display.bounds));
        },
    };
}

module.exports = { createForegroundProbe };
