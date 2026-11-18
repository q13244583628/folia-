// 任务栏控制条 —— client 入口（渲染进程）
//
// 职责：把控制条上的点击变成真正的播放动作，并把当前歌曲 / 播放状态 / 音量 /
// 循环模式推给主进程，由主进程转交给任务栏上的那根透明控制条。

export default function activate(folium) {
    // 低版本宿主没有 1.7 才有的 rpc.send / rpc.on，先挡一下
    if (!folium.rpc || typeof folium.rpc.on !== 'function') {
        folium.log.error('宿主 Folium 版本过低，缺少 rpc 能力');
        return;
    }

    // ---- 设置：宽度、左偏移、底部留白、透明度
    const section = folium.registries.settingsSections.register({
        id: 'bar',
        label: { 'zh-CN': '任务栏控制条', en: 'Taskbar control bar' },
        description: {
            'zh-CN': '控制条贴在屏幕底部任务栏左侧。改了尺寸后会自动重新贴边。',
            en: 'The bar sits over the left end of the bottom taskbar.',
        },
        settings: [
            {
                key: 'barWidth',
                type: 'number',
                label: { 'zh-CN': '宽度（像素）', en: 'Width (px)' },
                min: 200,
                max: 900,
                step: 10,
                defaultValue: 320,
            },
            {
                key: 'offsetX',
                type: 'number',
                label: { 'zh-CN': '距屏幕左边（像素）', en: 'Left offset (px)' },
                min: 0,
                max: 2000,
                step: 1,
                defaultValue: 10,
                description: { 'zh-CN': '默认 10，避开任务栏最左的边缘。', en: 'Default 10.' },
            },
            {
                key: 'bottomGap',
                type: 'number',
                label: { 'zh-CN': '距屏幕底边（像素）', en: 'Bottom gap (px)' },
                min: 0,
                max: 40,
                step: 1,
                defaultValue: 2,
            },
            {
                key: 'barOpacity',
                type: 'number',
                label: { 'zh-CN': '整体不透明度', en: 'Opacity' },
                min: 0.4,
                max: 1,
                step: 0.05,
                defaultValue: 1,
            },
            {
                key: 'showTitle',
                type: 'boolean',
                label: { 'zh-CN': '展开时显示歌曲标题', en: 'Show song title when expanded' },
                defaultValue: true,
            },
        ],
    });

    const readSettings = () => section.settings.get();

    const pushConfig = () => {
        const values = readSettings();
        folium.rpc.call('tb-config', {
            width: Number(values.barWidth) || 320,
            offsetX: Number(values.offsetX) || 0,
            bottomGap: Number(values.bottomGap) || 0,
            opacity: Number(values.barOpacity) || 1,
        }).catch((error) => folium.log.warn('推送控制条配置失败', error));
    };

    // ---- 状态快照
    const snapshot = () => {
        const state = folium.playback.getState();
        const volume = folium.playback.getVolume();
        const values = readSettings();
        return {
            state: state.state,
            title: state.song?.title ?? '',
            artist: state.song?.artist ?? '',
            position: state.position,
            duration: state.duration,
            liked: Boolean(state.liked),
            canLike: Boolean(state.canLike),
            volume: volume.volume,
            muted: volume.muted,
            loop: folium.playback.getLoopMode(),
            showTitle: values.showTitle !== false,
        };
    };

    let lastJson = '';
    const push = () => {
        try {
            const data = snapshot();
            const json = JSON.stringify(data);
            // 位置每秒都在变，只在有意义的变化时推，减少 IPC 噪声
            if (json === lastJson) return;
            lastJson = json;
            folium.rpc.call('tb-state', data).catch((error) => folium.log.warn('推送播放状态失败', error));
        } catch (error) {
            folium.log.warn('读取播放状态失败', error);
        }
    };

    // ---- 控制条上的点击
    const LOOP_NEXT = { off: 'all', all: 'one', one: 'off' };

    const actions = {
        toggle: () => folium.playback.toggle(),
        play: () => folium.playback.play(),
        pause: () => folium.playback.pause(),
        next: () => folium.playback.next(),
        previous: () => folium.playback.previous(),
        like: () => folium.playback.toggleLike(),
        mute: () => {
            const { muted } = folium.playback.getVolume();
            folium.playback.setMuted(!muted);
        },
        loop: () => {
            const current = folium.playback.getLoopMode();
            folium.playback.setLoopMode(LOOP_NEXT[current] ?? 'off');
        },
        volume: (value) => {
            const volume = Number(value);
            if (Number.isFinite(volume)) folium.playback.setVolume(Math.min(1, Math.max(0, volume)));
        },
        seek: (value) => {
            const seconds = Number(value);
            if (Number.isFinite(seconds)) folium.playback.seek(Math.max(0, seconds));
        },
        panel: () => folium.ui.openPlayerPanel(),
        // 返回一层等同按 Esc；没有可返回的层级时 back() 返回 false，给个提示，
        // 免得看起来像「按了没反应」
        back: () => {
            const handled = typeof folium.ui.back === 'function' ? folium.ui.back() : false;
            if (!handled) {
                folium.ui.toast('当前没有可以返回的层级', { type: 'info', durationMs: 1500 });
            }
        },
    };

    folium.rpc.on('tb-cmd', (payload) => {
        const action = payload?.action;
        const handler = actions[action];
        if (!handler) {
            folium.log.warn(`控制条发来未知指令：${action}`);
            return;
        }
        try {
            const result = handler(payload?.value);
            folium.log.info(`控制条指令 ${action} -> ${String(result)}`);
            // 宿主明确拒绝（喜欢不可用、没有可返回层级等）时回显到控制条上
            if (result === false) {
                folium.rpc.call('tb-error', { action, message: '宿主拒绝了这次操作' }).catch(() => { });
            }
        } catch (error) {
            folium.log.error(`指令 ${action} 执行失败`, error);
            folium.rpc
                .call('tb-error', { action, message: String(error?.message ?? error) })
                .catch(() => { });
        }
        // 动作完成后立刻刷新一次，控制条不用等下一拍
        setTimeout(push, 120);
    });

    // ---- 宿主事件 → 刷新
    [
        'playback.songChanged',
        'playback.stateChanged',
        'playback.volumeChanged',
        'playback.loopModeChanged',
        'playback.likeChanged',
        'playback.seeked',
    ].forEach((event) => {
        try {
            folium.events.on(event, () => push());
        } catch (error) {
            folium.log.warn(`订阅事件 ${event} 失败`, error);
        }
    });

    // 进度每秒走一次
    folium.every(1000, push);

    section.settings.onChange(() => {
        lastJson = '';
        pushConfig();
        push();
    });

    // ---- 命令：贴回任务栏左下角（控制条被别的置顶窗口盖住时用）
    folium.registries.commands.register({
        id: 'snap-back',
        label: { 'zh-CN': '任务栏控制条：贴回左下角', en: 'Taskbar bar: snap back' },
        description: {
            'zh-CN': '重新把控制条放到任务栏左下方，并提到最上层。',
            en: 'Re-place the bar over the taskbar and raise it.',
        },
        keywords: ['taskbar', 'bar', 'snap'],
        run: () => {
            pushConfig();
            return '已把控制条贴回任务栏左下角';
        },
    });

    // 启动时先对齐一次
    pushConfig();
    push();

    return () => {
        lastJson = '';
    };
}
