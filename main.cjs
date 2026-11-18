'use strict';

// 任务栏控制条 —— main 入口（主进程）
//
// 职责：在屏幕底部任务栏左下方创建一条「无边框 + 全透明 + 置顶」的窗口，
// 把渲染层（bar.html）发来的点击指令转给 client 入口，再把 client 推来的
// 播放状态回灌给 bar.html。
//
// 关于焦点：这个窗口必须是「可获得焦点」的（focusable: true）。
// Windows 上如果创建成 WS_EX_NOACTIVATE（Electron 的 focusable: false），
// Chromium 只把鼠标移动转发给渲染进程，按下/抬起事件会被丢掉——表现就是
// 悬停有反应、点击没反应。所以这里不能用 focusable: false。

const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');
const { createForegroundProbe } = require('./foreground.cjs');

const BAR_FILE = path.join(__dirname, 'bar.html');

const DEFAULTS = {
    width: 320,
    offsetX: 10,
    bottomGap: 2,
    opacity: 1,
};

const COLLAPSED_HEIGHT = 40;
const FULLSCREEN_POLL_MS = 800;

module.exports = function activate(api) {
    let win = null;
    let disposed = false;
    const config = { ...DEFAULTS };

    let currentHeight = COLLAPSED_HEIGHT;
    let currentWidth = DEFAULTS.width;
    // 有全屏程序在前台时，控制条要主动藏起来
    let hiddenForFullscreen = false;
    let fullscreenProbe = null;

    api.log.info('任务栏控制条启动');

    const readScreen = () => {
        const display = screen.getPrimaryDisplay();
        const bounds = display.bounds;
        const work = display.workArea;
        let edge = 'bottom';
        if (work.y > bounds.y) edge = 'top';
        else if (work.x > bounds.x) edge = 'left';
        else if (work.x + work.width < bounds.x + bounds.width) edge = 'right';
        else if (work.height < bounds.height) edge = 'bottom';
        return { bounds, work, edge };
    };

    // 底部对齐：展开时窗口向上长，底边不动
    const boundsFor = (height, width) => {
        const { bounds, work, edge } = readScreen();
        const gap = Math.max(0, Math.round(config.bottomGap));
        const w = Math.max(120, Math.round(width ?? config.width));
        const h = Math.max(32, Math.round(height));
        let x;
        let y;
        if (edge === 'top') {
            x = work.x + Math.round(config.offsetX);
            y = bounds.y + gap;
        } else if (edge === 'left') {
            x = work.x;
            y = bounds.y + bounds.height - h - gap;
        } else if (edge === 'right') {
            x = work.x + work.width - w;
            y = bounds.y + bounds.height - h - gap;
        } else {
            x = Math.round(work.x + config.offsetX);
            y = bounds.y + bounds.height - h - gap;
        }
        return { x, y, width: w, height: h };
    };

    const resetTopmost = () => {
        if (!win || win.isDestroyed()) return;
        if (hiddenForFullscreen) return;
        win.setAlwaysOnTop(true, 'screen-saver', 1);
        if (typeof win.moveTop === 'function') win.moveTop();
        win.setIgnoreMouseEvents(false);
    };

    const place = (height, width) => {
        if (!win || win.isDestroyed()) return;
        win.setBounds(boundsFor(height, width));
        resetTopmost();
    };

    const createWindow = () => {
        const initial = boundsFor(currentHeight, currentWidth);
        win = new BrowserWindow({
            ...initial,
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            // 必须保持 resizable：Windows 上不可调尺寸的窗口，程序化 setBounds 改不动高度
            resizable: true,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            hasShadow: false,
            // 关键：必须 focusable，否则 Windows 下收不到鼠标按下（只剩悬停）
            focusable: true,
            acceptFirstMouse: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                backgroundThrottling: false,
            },
        });
        win.setAlwaysOnTop(true, 'screen-saver', 1);
        win.setSkipTaskbar(true);
        win.setMenuBarVisibility(false);
        win.setOpacity(Math.min(1, Math.max(0.2, Number(config.opacity) || 1)));
        win.loadFile(BAR_FILE);
        win.webContents.once('did-finish-load', () => {
            if (!win || win.isDestroyed()) return;
            win.showInactive();
            place(currentHeight, currentWidth);
        });
        win.on('closed', () => {
            win = null;
        });
    };

    createWindow();

    // ---- 全屏让位：前台程序全屏时把控制条藏起来，退出全屏后自动回来
    fullscreenProbe = createForegroundProbe(api.log);
    const ownHwnds = () => {
        if (!win || win.isDestroyed()) return [];
        try {
            const handle = win.getNativeWindowHandle();
            if (handle.length >= 8) return [Number(handle.readBigUInt64LE(0))];
            return [handle.readUInt32LE(0)];
        } catch (error) {
            return [];
        }
    };
    const fullscreenTimer = setInterval(() => {
        if (disposed || !fullscreenProbe) return;
        if (!win || win.isDestroyed()) return;
        let active = false;
        try {
            active = fullscreenProbe.isFullscreenForeground(ownHwnds());
        } catch (error) {
            active = false;
        }
        if (active && !hiddenForFullscreen) {
            hiddenForFullscreen = true;
            try {
                win.hide();
            } catch (error) {
                hiddenForFullscreen = false;
            }
            api.log.info('前台程序全屏，控制条临时隐藏');
        } else if (!active && hiddenForFullscreen) {
            hiddenForFullscreen = false;
            try {
                win.showInactive();
                place(currentHeight, currentWidth);
            } catch (error) {
                /* 窗口可能正在销毁 */
            }
            api.log.info('退出全屏，控制条恢复显示');
        }
    }, FULLSCREEN_POLL_MS);

    // ---- 渲染层 → 主进程
    ipcMain.on('tb-resize', (_event, size) => {
        if (!size) return;
        currentHeight = Number(size.height) || COLLAPSED_HEIGHT;
        currentWidth = Number(size.width) || config.width;
        place(currentHeight, currentWidth);
    });

    ipcMain.on('tb-cmd', (_event, payload) => {
        if (disposed) return;
        api.log.info(`控制条点击：${payload?.action ?? '?'}`);
        try {
            api.rpc.send('tb-cmd', payload);
        } catch (error) {
            api.log.warn('转发指令失败', error);
            if (win && !win.isDestroyed()) {
                win.webContents.send('tb-error', {
                    action: payload?.action,
                    message: String(error?.message ?? error),
                });
            }
        }
    });

    // ---- client 入口 → 主进程
    api.rpc.handle('tb-state', (snapshot) => {
        if (win && !win.isDestroyed()) win.webContents.send('tb-state', snapshot ?? null);
        return true;
    });

    api.rpc.handle('tb-error', (payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('tb-error', payload ?? null);
        return true;
    });

    api.rpc.handle('tb-config', (patch) => {
        if (patch && typeof patch === 'object') {
            ['width', 'offsetX', 'bottomGap', 'opacity'].forEach((key) => {
                const value = Number(patch[key]);
                if (Number.isFinite(value)) config[key] = value;
            });
            if (win && !win.isDestroyed()) {
                win.setOpacity(Math.min(1, Math.max(0.2, config.opacity)));
                currentWidth = config.width;
                place(currentHeight, currentWidth);
            }
        }
        return true;
    });

    const topTimer = setInterval(resetTopmost, 1500);

    const onDisplayChange = () => {
        if (!win || win.isDestroyed()) return;
        place(currentHeight, currentWidth);
    };
    screen.on('display-metrics-changed', onDisplayChange);
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);

    const dispose = () => {
        disposed = true;
        clearInterval(topTimer);
        clearInterval(fullscreenTimer);
        screen.removeListener('display-metrics-changed', onDisplayChange);
        screen.removeListener('display-added', onDisplayChange);
        screen.removeListener('display-removed', onDisplayChange);
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
    };

    api.onDispose(dispose);
    return dispose;
};
