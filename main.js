(async () => {
    "use strict";

    /* =========================================================================
     * 1. CONFIGURATION & CONSTANTS
     * =========================================================================
     * User-customizable settings, UI color scheme, and Discord brand stylings.
     */
    const CONFIG = {
        NAME: "Nova Quests",
        VERSION: "v5.0.0",
        AUTHOR: "Nova",
        THEME: "#5865F2",            // Discord Blurple brand accent
        SUCCESS: "#3BA55C",          // Green status
        WARN: "#FAA61A",             // Amber warning
        ERR: "#ED4245",              // Red error
        MAX_LOG_ITEMS: 80,           // Number of logs preserved in UI
        HIDE_ACTIVITY: false         // Hide "Playing ..." during quest runs
    };

    /* System limits and safety timers */
    const SYS = Object.freeze({
        MAX_TIME: 25 * 60 * 1000,    // 25 minutes safety abort per task
        HEARTBEAT_GRACE: 90 * 1000,  // Max timeout if Discord sends no heartbeat
        MAX_TASK_FAILURES: 5,        // Threshold for consecutive network failures
        MAX_RETRIES: 3,              // Retries for transient 429/5xx errors
        IS_DESKTOP: typeof window.DiscordNative !== 'undefined'
    });

    /* Global runtime state */
    const RUNTIME = {
        running: true,
        cleanups: new Set(),         // Event listener and patch cleanups
        autoEnroll: true,            // Auto accept quests before starting
        autoClaim: true,             // Auto claim completed rewards
        playSound: true,             // Audio cue on completion
        randomDelay: false           // Randomized anti-detection delays
    };

    /* Blacklisted quest IDs and core event names */
    const CONST = Object.freeze({
        BLACKLIST_ID: "1412491570820812933",
        EVT: Object.freeze({
            HEARTBEAT: "QUESTS_SEND_HEARTBEAT_SUCCESS",
            GAME: "RUNNING_GAMES_CHANGE",
            RPC: "LOCAL_ACTIVITY_UPDATE"
        })
    });

    /* Re-entrance lock: prevent double injection in the same Discord client tab */
    if (window.novaLock) {
        const existingUI = document.getElementById('nova-ui');
        if (existingUI) existingUI.style.display = 'flex';
        return console.warn(`[${CONFIG.NAME}] Already active in this session.`);
    }
    window.novaLock = true;

    /* =========================================================================
     * 2. AUDIO & FEEDBACK ENGINE
     * =========================================================================
     * Synthesizes smooth web-audio chimes without loading external sound files.
     */
    const Sound = {
        _ctx: null,
        play(type) {
            if (!RUNTIME.playSound) return;
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) return;

                if (!this._ctx || this._ctx.state === 'closed') {
                    this._ctx = new AudioContextClass();
                }
                const ctx = this._ctx;
                if (ctx.state === 'suspended') ctx.resume();

                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                const t0 = ctx.currentTime;
                if (type === 'done') {
                    // Success arpeggio: C5 -> E5 -> G5 -> C6
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(523.25, t0);
                    osc.frequency.setValueAtTime(659.25, t0 + 0.10);
                    osc.frequency.setValueAtTime(783.99, t0 + 0.20);
                    osc.frequency.setValueAtTime(1046.50, t0 + 0.30);
                    gain.gain.setValueAtTime(0.4, t0);
                    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.65);
                    osc.start(t0);
                    osc.stop(t0 + 0.7);
                } else {
                    // Soft notification tick
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(880, t0);
                    gain.gain.setValueAtTime(0.3, t0);
                    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
                    osc.start(t0);
                    osc.stop(t0 + 0.18);
                }
            } catch (_) {}
        }
    };

    /* =========================================================================
     * 3. SVG ICONS & ASSETS
     * =========================================================================
     */
    const ICONS = Object.freeze({
        SPARKLE: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L14.4 8.6L21 11L14.4 13.4L12 20L9.6 13.4L3 11L9.6 8.6L12 2Z"/></svg>`,
        BOLT: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.29-.62L14.5 3h1l-1 7h3.5c.58 0 .57.32.29.62L11 21z"/></svg>`,
        VIDEO: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`,
        GAME: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
        STREAM: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
        ACTIVITY: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>`,
        CHECK: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
        CLOCK: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        STOP: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`,
        GEAR: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`
    });

    /* =========================================================================
     * 4. UTILITIES & STRING HELPERS
     * =========================================================================
     */
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    
    // HTML-escape dynamic content to prevent markup injection
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    // Check quest expiration date reliably
    const notExpired = q => {
        try {
            if (typeof Mods.QuestStore?.isQuestExpired === 'function') {
                return Mods.QuestStore.isQuestExpired(q.id) !== true;
            }
        } catch (_) {}
        const exp = new Date(q.config?.expiresAt ?? 0).getTime();
        return Number.isNaN(exp) || exp > Date.now();
    };

    // Attribution traffic token required by Discord's recent API changes
    const sealedFor = questId => {
        try {
            return Mods.QuestStore?.getQuest?.(questId)?.trafficMetadataSealed ?? null;
        } catch (_) {
            return null;
        }
    };

    // Voice channel stream key generator for Activity tasks
    const buildStreamKey = () => {
        try {
            const ownerId = Mods.UserStore?.getCurrentUser?.()?.id;
            if (!ownerId) return null;

            const dm = Mods.ChanStore?.getSortedPrivateChannels()?.[0]?.id;
            if (dm) return `call:${dm}:${ownerId}`;

            for (const g of Object.values(Mods.GuildChanStore?.getAllGuilds() ?? {})) {
                const vc = g?.VOCAL?.[0]?.channel;
                const guildId = vc?.guild_id ?? g?.id;
                if (vc?.id && guildId) return `guild:${guildId}:${vc.id}:${ownerId}`;
            }
            return null;
        } catch (e) {
            Logger.log(`[StreamKey] Lookup error: ${e.message}`, 'debug');
            return null;
        }
    };

    /* =========================================================================
     * 5. ERROR HANDLER & NETWORK CLASSIFIER
     * =========================================================================
     */
    const ErrorHandler = {
        RETRYABLE: new Set([429, 500, 502, 503, 504, 408]),
        CLIENT_ERRORS: new Set([400, 403, 404, 409, 410]),

        classify(error) {
            const status = error?.status ?? error?.statusCode;
            return {
                isRetryable: this.RETRYABLE.has(status),
                isClientError: this.CLIENT_ERRORS.has(status),
                status,
                message: error?.message ?? error?.body?.message ?? `HTTP ${status ?? 'UNKNOWN'}`
            };
        },

        isSkippableQuest(error) {
            const status = error?.status;
            return status === 404 || status === 403 || status === 410;
        }
    };

    /* =========================================================================
     * 6. USER INTERFACE & LOGGING SYSTEM (IMPROVED UI)
     * =========================================================================
     * Custom floating glassmorphic dashboard styled to blend seamlessly with Discord.
     */
    const Logger = {
        root: null,
        tasks: new Map(),
        tickerId: null,
        _hotkey: null,

        init() {
            const oldUI = document.getElementById('nova-ui');
            if (oldUI) oldUI.remove();
            const oldStyle = document.getElementById('nova-styles');
            if (oldStyle) oldStyle.remove();

            const style = document.createElement('style');
            style.id = 'nova-styles';
            style.innerHTML = `
                @keyframes novaSlide {
                    from { transform: translateY(-16px) scale(0.97); opacity: 0; }
                    to { transform: translateY(0) scale(1); opacity: 1; }
                }
                @keyframes novaGlow {
                    0%, 100% { filter: drop-shadow(0 0 10px rgba(88,101,242,0.4)); }
                    50% { filter: drop-shadow(0 0 18px rgba(88,101,242,0.8)); }
                }

                #nova-ui {
                    position: fixed;
                    top: 24px;
                    right: 24px;
                    width: 400px;
                    max-height: 56vh;
                    background: color-mix(in srgb, var(--background-base-low, #18191c) 92%, #5865F2 8%);
                    backdrop-filter: blur(16px);
                    color: var(--text-default, #dcddde);
                    border: 1px solid color-mix(in srgb, var(--border-subtle, #202225) 80%, #5865F2 20%);
                    border-radius: 14px;
                    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.05);
                    z-index: 99999;
                    font-family: var(--font-primary, 'gg sans', 'Noto Sans', sans-serif);
                    overflow: hidden;
                    animation: novaSlide 0.35s cubic-bezier(0.16, 1, 0.3, 1);
                    display: flex;
                    flex-direction: column;
                    box-sizing: border-box;
                    user-select: none;
                }

                #nova-head {
                    padding: 12px 16px;
                    background: rgba(0, 0, 0, 0.25);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    cursor: grab;
                }
                #nova-head.dragging { cursor: grabbing; background: rgba(88, 101, 242, 0.15); }

                #nova-title {
                    font-weight: 700;
                    font-size: 14px;
                    color: #fff;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    letter-spacing: 0.3px;
                }
                #nova-title .nova-icon {
                    color: #5865F2;
                    display: flex;
                    animation: novaGlow 3s infinite ease-in-out;
                }
                .nova-tag {
                    font-size: 10px;
                    font-weight: 800;
                    padding: 2px 7px;
                    border-radius: 10px;
                    background: linear-gradient(135deg, #5865F2, #a358f2);
                    color: #fff;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                }
                .nova-ver {
                    font-size: 10px;
                    opacity: 0.6;
                    font-weight: 600;
                }

                #nova-controls {
                    display: flex;
                    gap: 8px;
                    align-items: center;
                }
                .nova-btn-ctrl {
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    color: var(--text-muted, #949ba4);
                    font-size: 11px;
                    font-weight: 700;
                    padding: 4px 8px;
                    border-radius: 6px;
                    transition: 0.15s ease;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .nova-btn-ctrl:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
                .nova-btn-stop {
                    color: #ED4245;
                    border: 1px solid rgba(237, 66, 69, 0.4);
                }
                .nova-btn-stop:hover {
                    background: #ED4245 !important;
                    color: #fff !important;
                }

                #nova-body {
                    flex: 1 1 auto;
                    padding: 12px;
                    min-height: 80px;
                    max-height: 250px;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                #nova-logs {
                    padding: 8px 12px;
                    background: rgba(0, 0, 0, 0.35);
                    font-family: 'Consolas', 'Fira Code', monospace;
                    font-size: 11px;
                    height: 105px;
                    overflow-y: auto;
                    border-top: 1px solid rgba(255, 255, 255, 0.08);
                }
                .nova-log-line {
                    display: flex;
                    gap: 8px;
                    line-height: 1.45;
                    margin-bottom: 4px;
                }
                .nova-log-ts { opacity: 0.45; min-width: 46px; font-size: 10px; }
                .c-info { color: #5865F2; }
                .c-success { color: #3BA55C; }
                .c-warn { color: #FAA61A; }
                .c-err { color: #ED4245; }
                .c-debug { color: #72767d; }

                /* Task Cards */
                .nova-card {
                    --state-color: #5865F2;
                    display: flex;
                    gap: 12px;
                    padding: 10px 12px;
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.04);
                    border: 1px solid rgba(255, 255, 255, 0.06);
                    border-left: 4px solid var(--state-color);
                    align-items: center;
                    transition: 0.2s ease;
                }
                .nova-card.done { --state-color: #3BA55C; }
                .nova-card.failed { --state-color: #ED4245; }
                .nova-card.pending { --state-color: #FAA61A; }

                .nova-task-icon {
                    width: 36px;
                    height: 36px;
                    border-radius: 50%;
                    background: color-mix(in srgb, var(--state-color) 20%, transparent);
                    color: var(--state-color);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    position: relative;
                }
                .nova-card.done .nova-task-icon {
                    background: #3BA55C;
                    color: #fff;
                }

                .nova-task-details {
                    flex: 1 1 auto;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }
                .nova-task-title {
                    font-size: 13px;
                    font-weight: 700;
                    color: #fff;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .nova-task-meta {
                    font-size: 11px;
                    color: var(--text-muted, #949ba4);
                    display: flex;
                    justify-content: space-between;
                }

                .nova-btn {
                    padding: 6px 12px;
                    border: none;
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 700;
                    cursor: pointer;
                    text-transform: uppercase;
                    transition: 0.15s;
                    font-family: inherit;
                }
                .nova-btn-claim {
                    background: #3BA55C;
                    color: #fff;
                }
                .nova-btn-claim:hover { background: #2d8047; }
                .nova-btn-start {
                    background: #5865F2;
                    color: #fff;
                    width: 100%;
                    padding: 9px;
                }
                .nova-btn-start:hover { background: #4752c4; }

                /* Custom Checkbox & Options */
                .nova-option {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background: rgba(255, 255, 255, 0.03);
                    padding: 8px 12px;
                    border-radius: 6px;
                }
                .nova-switch {
                    appearance: none;
                    width: 36px;
                    height: 18px;
                    background: rgba(255,255,255,0.15);
                    border-radius: 20px;
                    cursor: pointer;
                    position: relative;
                    transition: 0.2s;
                }
                .nova-switch::after {
                    content: '';
                    position: absolute;
                    top: 2px; left: 2px;
                    width: 14px; height: 14px;
                    background: #fff;
                    border-radius: 50%;
                    transition: 0.2s;
                }
                .nova-switch:checked { background: #5865F2; }
                .nova-switch:checked::after { transform: translateX(18px); }

                #nova-ui ::-webkit-scrollbar { width: 4px; }
                #nova-ui ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
            `;
            document.head.appendChild(style);

            this.root = document.createElement('div');
            this.root.id = 'nova-ui';
            this.root.innerHTML = `
                <div id="nova-head">
                    <span id="nova-title">
                        <span class="nova-icon">${ICONS.SPARKLE}</span>
                        ${CONFIG.NAME}
                        <span class="nova-tag">Made by Nova</span>
                        <span class="nova-ver">${CONFIG.VERSION}</span>
                    </span>
                    <div id="nova-controls">
                        <button class="nova-btn-ctrl nova-btn-stop" id="nova-stop" title="Stop Script">${ICONS.STOP} Stop</button>
                        <button class="nova-btn-ctrl" id="nova-opts" title="Options">${ICONS.GEAR}</button>
                        <button class="nova-btn-ctrl" id="nova-close" title="Hide/Show (Shift + .)">Hide</button>
                    </div>
                </div>
                <div id="nova-body"><div style="text-align:center; padding:24px; color:var(--text-muted); font-size:12px;">Initializing Nova Quest Engine...</div></div>
                <div id="nova-logs"></div>
            `;
            document.body.appendChild(this.root);

            const head = document.getElementById('nova-head');

            // Dragging behavior
            head.addEventListener('mousedown', e => {
                if (e.target.closest('.nova-btn-ctrl')) return;
                head.classList.add('dragging');
                const startX = e.clientX, startY = e.clientY;
                const rect = this.root.getBoundingClientRect();
                const initX = rect.left, initY = rect.top;

                this.root.style.left = `${initX}px`;
                this.root.style.top = `${initY}px`;
                this.root.style.right = 'auto';

                const onMove = ev => {
                    this.root.style.left = `${Math.max(0, Math.min(initX + (ev.clientX - startX), window.innerWidth - this.root.offsetWidth))}px`;
                    this.root.style.top = `${Math.max(0, Math.min(initY + (ev.clientY - startY), window.innerHeight - 50))}px`;
                };
                const onUp = () => {
                    head.classList.remove('dragging');
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });

            // UI controls
            document.getElementById('nova-close').onclick = () => this.toggle();
            document.getElementById('nova-stop').onclick = () => this.shutdown();

            this._hotkey = e => (e.key === '>' || (e.shiftKey && e.key === '.')) && this.toggle();
            document.addEventListener('keydown', this._hotkey);

            // Options toggler
            document.getElementById('nova-opts').addEventListener('click', () => {
                const optPanel = document.getElementById('nova-options-panel');
                const list = document.getElementById('nova-quest-list');
                const actions = document.getElementById('nova-picker-actions');
                if (!optPanel) return;
                const open = optPanel.style.display === 'none';
                optPanel.style.display = open ? 'flex' : 'none';
                if (list) list.style.display = open ? 'none' : 'flex';
                if (actions) actions.style.display = open ? 'none' : 'flex';
            });

            // Claim reward clicks
            document.getElementById('nova-body').addEventListener('click', async e => {
                if (e.target.classList.contains('nova-btn-claim')) {
                    const btn = e.target;
                    const qId = btn.getAttribute('data-id');
                    btn.disabled = true;
                    btn.innerText = "Claiming...";
                    try {
                        const res = await Tasks.claimReward(qId);
                        if (res?.body?.claimed_at) {
                            btn.innerText = "Claimed!";
                            Logger.log(`[Claim] Reward claimed successfully!`, 'success');
                            setTimeout(() => this.removeTask(qId), 2000);
                        }
                    } catch (err) {
                        btn.innerText = "Check App";
                        Logger.log(`[Claim] Action required in Discord UI.`, 'warn');
                    }
                }
            });

            this.startTicker();
        },

        toggle() {
            if (!this.root) return;
            this.root.style.display = this.root.style.display === 'none' ? 'flex' : 'none';
        },

        shutdown() {
            if (!RUNTIME.running) return;
            RUNTIME.running = false;
            this.log("[System] Stopping Nova and restoring client state...", "warn");

            if (this.tickerId) clearInterval(this.tickerId);
            if (this._hotkey) document.removeEventListener('keydown', this._hotkey);

            for (const cleanup of RUNTIME.cleanups) {
                try { cleanup(); } catch (_) {}
            }
            RUNTIME.cleanups.clear();
            Patcher.clean();

            window.novaLock = false;
            const root = this.root;
            const styles = document.getElementById('nova-styles');
            setTimeout(() => {
                if (styles) styles.remove();
                if (root) root.remove();
            }, 800);
        },

        startTicker() {
            if (this.tickerId) clearInterval(this.tickerId);
            this.tickerId = setInterval(() => {
                if (!RUNTIME.running) return clearInterval(this.tickerId);
                for (const [id, task] of this.tasks.entries()) {
                    if (task.status !== "RUNNING" || task.type === "ACHIEVEMENT") continue;

                    let cur = task.cur;
                    if (task.type === "GAME" || task.type === "STREAM") {
                        if (task.serverAt != null) {
                            cur = Math.min(task.serverCur + (Date.now() - task.serverAt) / 1000, task.max);
                        }
                    } else {
                        cur = Math.min(task.cur + 1, task.max);
                    }
                    this.updateTask(id, { cur });
                }
            }, 1000);
        },

        updateTask(id, data) {
            const old = this.tasks.get(id) || {};
            const isDone = data.status === "COMPLETED" || data.status === "CLAIMED";
            const isFailed = data.status === "FAILED";
            const isPending = data.status === "PENDING" || data.status === "QUEUE";

            const updated = { ...old, ...data, done: isDone, failed: isFailed, pending: isPending };
            this.tasks.set(id, updated);
            this.render();
        },

        removeTask(id) {
            this.tasks.delete(id);
            this.render();
        },

        log(msg, type = 'info') {
            const colors = { info: CONFIG.THEME, success: CONFIG.SUCCESS, warn: CONFIG.WARN, err: CONFIG.ERR, debug: "#72767d" };
            console.log(`%c[NOVA] %c${msg}`, `color: ${CONFIG.THEME}; font-weight: bold;`, `color: ${colors[type] || colors.info}`);

            const box = document.getElementById('nova-logs');
            if (box && type !== 'debug') {
                const el = document.createElement('div');
                el.className = `nova-log-line c-${type}`;
                el.innerHTML = `<span class="nova-log-ts">${new Date().toLocaleTimeString().split(' ')[0]}</span> <span>${esc(msg)}</span>`;
                box.appendChild(el);
                box.scrollTop = box.scrollHeight;
                while (box.children.length > CONFIG.MAX_LOG_ITEMS) box.firstChild.remove();
            }
        },

        render() {
            if (document.getElementById('nova-picker-form')) return;
            const body = document.getElementById('nova-body');
            if (!body) return;

            if (!this.tasks.size) {
                body.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-muted); font-size:12px;">Waiting for tasks to start...</div>`;
                return;
            }

            body.innerHTML = [...this.tasks.entries()].map(([id, t]) => {
                const pct = t.max ? Math.min(100, Math.floor((t.cur / t.max) * 100)) : 0;
                const stateClass = t.done ? 'done' : t.failed ? 'failed' : t.pending ? 'pending' : 'running';
                const icon = t.done ? ICONS.CHECK : t.failed ? ICONS.STOP : t.pending ? ICONS.CLOCK : (ICONS[t.type] || ICONS.BOLT);

                return `
                <div class="nova-card ${stateClass}">
                    <div class="nova-task-icon">${icon}</div>
                    <div class="nova-task-details">
                        <div class="nova-task-title">${esc(t.name)}</div>
                        <div class="nova-task-meta">
                            <span>${t.status}</span>
                            <span>${Math.floor(t.cur)} / ${t.max}s (${pct}%)</span>
                        </div>
                    </div>
                    ${t.claimable ? `<button class="nova-btn nova-btn-claim" data-id="${esc(id)}">Claim</button>` : ''}
                </div>`;
            }).join('');
        },

        showQuestPicker(quests) {
            return new Promise(resolve => {
                const body = document.getElementById('nova-body');
                const logs = document.getElementById('nova-logs');

                const finish = data => {
                    if (logs) logs.style.display = 'block';
                    if (body) body.innerHTML = '';
                    resolve(data);
                };

                if (!body) return finish({ selected: new Set(), autoEnroll: true, autoClaim: true, playSound: true, randomDelay: false });
                if (logs) logs.style.display = 'none';

                const items = [];
                quests.forEach(q => {
                    const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                    if (!cfg?.tasks) return;
                    const typeData = Tasks.detectType(cfg, q.config?.application?.id);
                    if (!typeData) return;
                    if (!SYS.IS_DESKTOP && (typeData.type === 'GAME' || typeData.type === 'STREAM')) return;

                    items.push({
                        id: q.id,
                        name: q.config?.messages?.questName ?? "Unknown Quest",
                        type: typeData.type
                    });
                });

                if (!items.length) return finish({ selected: new Set() });

                body.innerHTML = `
                    <form id="nova-picker-form" style="display:flex; flex-direction:column; gap:10px;">
                        <div id="nova-options-panel" style="display:none; flex-direction:column; gap:6px;">
                            <div class="nova-option"><span>Auto-enroll</span><input type="checkbox" name="autoEnroll" class="nova-switch" checked></div>
                            <div class="nova-option"><span>Auto-claim</span><input type="checkbox" name="autoClaim" class="nova-switch" checked></div>
                            <div class="nova-option"><span>Sound cue</span><input type="checkbox" name="playSound" class="nova-switch" checked></div>
                            <div class="nova-option"><span>Random delay (1-30m)</span><input type="checkbox" name="randomDelay" class="nova-switch"></div>
                        </div>
                        <div id="nova-quest-list" style="display:flex; flex-direction:column; gap:6px; max-height:160px; overflow-y:auto;">
                            ${items.map(item => `
                                <label style="display:flex; align-items:center; gap:10px; background:rgba(255,255,255,0.04); padding:8px; border-radius:6px; cursor:pointer;">
                                    <input type="checkbox" name="quest" value="${item.id}" checked>
                                    <span style="font-size:12px; font-weight:600; color:#fff;">${esc(item.name)}</span>
                                    <span style="font-size:10px; color:#5865F2; margin-left:auto; font-weight:700;">${item.type}</span>
                                </label>
                            `).join('')}
                        </div>
                        <div id="nova-picker-actions" style="display:flex; gap:8px;">
                            <button type="submit" class="nova-btn nova-btn-start">${ICONS.BOLT} Start Selected (${items.length})</button>
                        </div>
                    </form>
                `;

                const form = document.getElementById('nova-picker-form');
                form.addEventListener('submit', e => {
                    e.preventDefault();
                    const data = new FormData(form);
                    const selected = new Set(data.getAll('quest'));
                    finish({
                        selected,
                        autoEnroll: data.has('autoEnroll'),
                        autoClaim: data.has('autoClaim'),
                        playSound: data.has('playSound'),
                        randomDelay: data.has('randomDelay')
                    });
                });
            });
        }
    };

    /* =========================================================================
     * 7. NETWORK QUEUE & RATE LIMITER
     * =========================================================================
     */
    const Traffic = {
        queue: [],
        processing: false,

        async enqueue(url, body) {
            if (!RUNTIME.running) return Promise.reject(new Error("Stopped"));
            return new Promise((resolve, reject) => {
                this.queue.push({ url, body, resolve, reject, attempts: 0 });
                this.process();
            });
        },

        async process() {
            if (this.processing || this.queue.length === 0) return;
            this.processing = true;

            while (this.queue.length > 0) {
                if (!RUNTIME.running) {
                    this.queue.forEach(req => req.reject(new Error("Shutdown")));
                    this.queue = [];
                    break;
                }

                const req = this.queue.shift();
                try {
                    const res = await Mods.API.post({ url: req.url, body: req.body });
                    req.resolve(res);
                } catch (e) {
                    const err = ErrorHandler.classify(e);
                    if (err.isRetryable && req.attempts < SYS.MAX_RETRIES) {
                        req.attempts++;
                        const delay = (e.body?.retry_after ?? Math.pow(2, req.attempts)) * 1000;
                        Logger.log(`[RateLimit] Backing off ${(delay/1000).toFixed(1)}s (HTTP ${err.status})`, 'warn');
                        await sleep(delay + rnd(200, 600));
                        this.queue.unshift(req);
                    } else {
                        req.reject(e);
                    }
                }
                await sleep(rnd(1000, 1600)); // Politeness interval
            }
            this.processing = false;
        }
    };

    /* =========================================================================
     * 8. WEBPACK MODULE RESOLVER
     * =========================================================================
     * Resiliently extracts Discord Flux Stores, Dispatcher, and Rest API.
     */
    let Mods = {};

    function loadModules() {
        try {
            // Check for Vencord Webpack API first
            if (typeof window.Vencord !== 'undefined' && window.Vencord.Webpack) {
                const W = window.Vencord.Webpack;
                Mods = {
                    QuestStore: W.findStore('QuestStore') || W.findStore('QuestsStore'),
                    RunStore: W.findStore('RunningGameStore'),
                    StreamStore: W.findStore('ApplicationStreamingStore'),
                    ChanStore: W.findStore('ChannelStore'),
                    GuildChanStore: W.findStore('GuildChannelStore'),
                    UserStore: W.findStore('UserStore'),
                    Dispatcher: W.Common?.FluxDispatcher || W.findByProps('dispatch', 'subscribe'),
                    API: W.Common?.RestAPI || W.findByProps('get', 'post', 'del')
                };
                if (Mods.QuestStore && Mods.API && Mods.Dispatcher && Mods.RunStore) {
                    Patcher.init(Mods.RunStore);
                    return true;
                }
            }

            // Native Webpack fallback
            if (typeof webpackChunkdiscord_app === 'undefined') {
                throw new Error("Webpack chunk not found.");
            }

            let req;
            webpackChunkdiscord_app.push([[Symbol()], {}, r => { req = r; }]);
            webpackChunkdiscord_app.pop();

            if (!req?.c) throw new Error("Webpack module cache unavailable.");
            const modules = Object.values(req.c);

            const findStore = name => modules.find(m => m?.exports?.A?.__proto__?.constructor?.displayName === name || m?.exports?.Ay?.constructor?.displayName === name)?.exports?.A || modules.find(m => m?.exports?.default?.constructor?.displayName === name)?.exports?.default;
            
            Mods = {
                QuestStore: modules.find(x => x?.exports?.A?.__proto__?.getQuest)?.exports?.A || findStore('QuestStore'),
                RunStore: modules.find(x => x?.exports?.Ay?.getRunningGames)?.exports?.Ay || findStore('RunningGameStore'),
                StreamStore: modules.find(x => x?.exports?.A?.__proto__?.getStreamerActiveStreamMetadata)?.exports?.A || findStore('ApplicationStreamingStore'),
                ChanStore: modules.find(x => x?.exports?.A?.__proto__?.getAllThreadsForParent)?.exports?.A || findStore('ChannelStore'),
                GuildChanStore: modules.find(x => x?.exports?.Ay?.getSFWDefaultChannel)?.exports?.Ay || findStore('GuildChannelStore'),
                UserStore: findStore('UserStore') || modules.find(x => x?.exports?.default?.getCurrentUser)?.exports?.default,
                Dispatcher: modules.find(x => x?.exports?.h?.__proto__?.flushWaitQueue)?.exports?.h || modules.find(x => x?.exports?.default?.dispatch && x?.exports?.default?.subscribe)?.exports?.default,
                API: modules.find(x => x?.exports?.Bo?.get)?.exports?.Bo || modules.find(x => x?.exports?.default?.get && x?.exports?.default?.post)?.exports?.default
            };

            if (!Mods.QuestStore || !Mods.API || !Mods.Dispatcher || !Mods.RunStore) {
                throw new Error("Essential Discord modules could not be resolved.");
            }

            Patcher.init(Mods.RunStore);
            return true;
        } catch (e) {
            Logger.log(`[Loader] Module init failed: ${e.message}`, 'err');
            return false;
        }
    }

    /* =========================================================================
     * 9. RUNNING GAME PATCHER & SPOOFER
     * =========================================================================
     */
    const Patcher = {
        games: [],
        real: {},
        active: false,

        init(Store) {
            if (!Store) return;
            this.real = {
                getRunningGames: Store.getRunningGames,
                getGameForPID: Store.getGameForPID,
                getVisibleGame: Store.getVisibleGame
            };
        },

        toggle(on) {
            const S = Mods.RunStore;
            if (!S) return;
            if (on && !this.active) {
                S.getRunningGames = () => [...(this.real.getRunningGames ? this.real.getRunningGames.call(S) : []), ...this.games];
                S.getGameForPID = pid => this.games.find(g => g.pid === pid) || (this.real.getGameForPID ? this.real.getGameForPID.call(S, pid) : null);
                if (this.real.getVisibleGame) S.getVisibleGame = () => this.games[0] || this.real.getVisibleGame.call(S);
                this.active = true;
            } else if (!on && this.active) {
                if (this.real.getRunningGames) S.getRunningGames = this.real.getRunningGames;
                if (this.real.getGameForPID) S.getGameForPID = this.real.getGameForPID;
                if (this.real.getVisibleGame) S.getVisibleGame = this.real.getVisibleGame;
                this.active = false;
            }
        },

        add(g) {
            if (this.games.some(x => x.pid === g.pid)) return;
            this.games.push(g);
            this.toggle(true);
            Mods.Dispatcher?.dispatch({ type: CONST.EVT.GAME, added: [g], removed: [], games: this.games });
        },

        remove(g) {
            this.games = this.games.filter(x => x.pid !== g.pid);
            Mods.Dispatcher?.dispatch({ type: CONST.EVT.GAME, added: [], removed: [g], games: this.games });
            if (!this.games.length) this.toggle(false);
        },

        clean() {
            this.games = [];
            this.toggle(false);
        }
    };

    /* =========================================================================
     * 10. TASK HANDLERS (VIDEO, GAME, STREAM, ACTIVITY)
     * =========================================================================
     */
    const Tasks = {
        detectType(cfg, appId) {
            const keys = Object.keys(cfg.tasks);
            if (keys.includes("WATCH_VIDEO") || keys.includes("WATCH_VIDEO_ON_MOBILE")) {
                const k = keys.find(x => x.includes("VIDEO"));
                return { type: "WATCH_VIDEO", keyName: k, target: cfg.tasks[k].target, appId };
            }
            if (keys.includes("PLAY_ON_DESKTOP") || keys.some(x => x.startsWith("PLAY_"))) {
                const k = keys.find(x => x.startsWith("PLAY_")) || "PLAY_ON_DESKTOP";
                return { type: "GAME", keyName: k, target: cfg.tasks[k].target, appId };
            }
            if (keys.includes("STREAM_ON_DESKTOP") || keys.some(x => x.startsWith("STREAM_"))) {
                const k = keys.find(x => x.startsWith("STREAM_")) || "STREAM_ON_DESKTOP";
                return { type: "STREAM", keyName: k, target: cfg.tasks[k].target, appId };
            }
            if (keys.includes("PLAY_ACTIVITY") || keys.includes("ACHIEVEMENT_IN_ACTIVITY")) {
                const k = keys.includes("PLAY_ACTIVITY") ? "PLAY_ACTIVITY" : "ACHIEVEMENT_IN_ACTIVITY";
                return { type: "ACTIVITY", keyName: k, target: cfg.tasks[k].target, appId };
            }
            return null;
        },

        async claimReward(questId) {
            return await Mods.API.post({
                url: `/quests/${questId}/claim-reward`,
                body: { platform: 0, location: 11, is_targeted: false, metadata_sealed: null, traffic_metadata_sealed: sealedFor(questId) }
            });
        },

        async fetchAppMeta(appId, name) {
            try {
                const res = await Mods.API.get({ url: `/applications/public?application_ids=${appId}` });
                const data = res?.body?.[0];
                const exe = data?.executables?.find(x => x.os === "win32")?.name?.replace(">", "") || `${name.replace(/[^a-zA-Z0-9]/g, "")}.exe`;
                return { name: data?.name || name, exeName: exe, id: appId };
            } catch (_) {
                return { name, exeName: `${name.replace(/[^a-zA-Z0-9]/g, "")}.exe`, id: appId };
            }
        },

        async VIDEO(q, t) {
            let cur = q.userStatus?.progress?.[t.keyName]?.value ?? 0;
            Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });

            while (cur < t.target && RUNTIME.running) {
                const delay = rnd(7000, 9500);
                await sleep(delay);
                cur += (delay / 1000);
                const payloadTs = Number(Math.min(t.target, cur).toFixed(6));

                try {
                    const res = await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: payloadTs });
                    if (res?.body?.completed_at) break;
                } catch (e) {
                    Logger.log(`[Video] Progress sync warning: ${e.message}`, 'debug');
                }
                Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });
            }

            if (RUNTIME.running) Tasks.finish(q, t);
        },

        async GAME(q, t) {
            const meta = await this.fetchAppMeta(t.appId, t.name);
            const pid = rnd(10000, 30000);
            const fakeGame = {
                id: meta.id,
                name: meta.name,
                pid,
                pidPath: [pid],
                processName: meta.name,
                start: Date.now(),
                exeName: meta.exeName,
                exePath: `c:/program files/${meta.name.toLowerCase()}/${meta.exeName}`,
                cmdLine: `C:\\Program Files\\${meta.name}\\${meta.exeName}`,
                hidden: false,
                isLauncher: false
            };

            Patcher.add(fakeGame);
            Logger.updateTask(q.id, { name: t.name, type: "GAME", cur: 0, max: t.target, status: "RUNNING" });

            return new Promise(resolve => {
                const onBeat = d => {
                    if (!RUNTIME.running) return cleanup();
                    if (d?.questId !== q.id) return;
                    const prog = d.userStatus?.progress?.[t.keyName]?.value ?? d.userStatus?.streamProgressSeconds ?? 0;
                    Logger.updateTask(q.id, { name: t.name, type: "GAME", cur: prog, max: t.target, status: "RUNNING", serverCur: prog, serverAt: Date.now() });

                    if (prog >= t.target) {
                        cleanup();
                        Tasks.finish(q, t);
                        resolve();
                    }
                };

                const cleanup = () => {
                    Patcher.remove(fakeGame);
                    Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, onBeat);
                };

                Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, onBeat);
                RUNTIME.cleanups.add(cleanup);
            });
        },

        async STREAM(q, t) {
            const real = Mods.StreamStore?.getStreamerActiveStreamMetadata;
            const pid = rnd(10000, 30000);
            if (Mods.StreamStore) {
                Mods.StreamStore.getStreamerActiveStreamMetadata = () => ({ id: t.appId, pid, sourceName: t.name });
            }

            Logger.updateTask(q.id, { name: t.name, type: "STREAM", cur: 0, max: t.target, status: "RUNNING" });

            return new Promise(resolve => {
                const onBeat = d => {
                    if (!RUNTIME.running) return cleanup();
                    if (d?.questId !== q.id) return;
                    const prog = d.userStatus?.progress?.[t.keyName]?.value ?? d.userStatus?.streamProgressSeconds ?? 0;
                    Logger.updateTask(q.id, { name: t.name, type: "STREAM", cur: prog, max: t.target, status: "RUNNING", serverCur: prog, serverAt: Date.now() });

                    if (prog >= t.target) {
                        cleanup();
                        Tasks.finish(q, t);
                        resolve();
                    }
                };

                const cleanup = () => {
                    if (Mods.StreamStore) Mods.StreamStore.getStreamerActiveStreamMetadata = real;
                    Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, onBeat);
                };

                Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, onBeat);
                RUNTIME.cleanups.add(cleanup);
            });
        },

        async ACTIVITY(q, t) {
            const streamKey = buildStreamKey();
            if (!streamKey) {
                Logger.log(`[Activity] Voice channel required for ${t.name}`, 'err');
                return;
            }

            let cur = 0;
            Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });

            while (cur < t.target && RUNTIME.running) {
                try {
                    const res = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: streamKey, terminal: false });
                    cur = res?.body?.progress?.[t.keyName]?.value ?? (cur + 20);
                    Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });

                    if (cur >= t.target) {
                        await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: streamKey, terminal: true });
                        break;
                    }
                } catch (e) {
                    Logger.log(`[Activity] Heartbeat error: ${e.message}`, 'warn');
                }
                await sleep(rnd(19000, 22000));
            }

            if (RUNTIME.running) Tasks.finish(q, t);
        },

        async finish(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
            Logger.log(`[Quest] Completed "${t.name}"!`, 'success');
            Sound.play('done');

            if (RUNTIME.autoClaim) {
                try {
                    await sleep(rnd(2000, 4000));
                    const res = await this.claimReward(q.id);
                    if (res?.body?.claimed_at) {
                        Logger.log(`[Claim] Reward for "${t.name}" auto-claimed!`, 'success');
                        Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                        setTimeout(() => Logger.removeTask(q.id), 2500);
                        return;
                    }
                } catch (_) {
                    Logger.log(`[Claim] Auto-claim challenged. Use UI button.`, 'warn');
                }
            }
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true });
        }
    };

    /* =========================================================================
     * 11. MAIN CONTROLLER & EXECUTION PIPELINE
     * =========================================================================
     */
    async function main() {
        Logger.init();
        if (!loadModules()) {
            return Logger.log('[System] Discord module discovery failed. Aborting.', 'err');
        }

        const getQuests = () => {
            const raw = Mods.QuestStore?.quests;
            return raw instanceof Map ? [...raw.values()] : Object.values(raw || {});
        };

        const activeQuests = getQuests().filter(q => !q.userStatus?.completedAt && notExpired(q) && q.id !== CONST.BLACKLIST_ID);

        if (!activeQuests.length) {
            Logger.log('[System] No uncompleted quests available.', 'success');
            return;
        }

        const picker = await Logger.showQuestPicker(activeQuests);
        if (!RUNTIME.running || !picker.selected.size) return;

        RUNTIME.autoEnroll = picker.autoEnroll;
        RUNTIME.autoClaim = picker.autoClaim;
        RUNTIME.playSound = picker.playSound;
        RUNTIME.randomDelay = picker.randomDelay;

        for (const quest of activeQuests) {
            if (!picker.selected.has(quest.id) || !RUNTIME.running) continue;

            const cfg = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
            const typeData = Tasks.detectType(cfg, quest.config?.application?.id);
            if (!typeData) continue;

            const tInfo = {
                name: quest.config?.messages?.questName || "Quest",
                target: typeData.target,
                type: typeData.type,
                keyName: typeData.keyName,
                appId: typeData.appId
            };

            // Auto enroll if not enrolled
            if (!quest.userStatus?.enrolledAt && RUNTIME.autoEnroll) {
                Logger.log(`[Enroll] Accepting quest: ${tInfo.name}`, 'info');
                try {
                    await Traffic.enqueue(`/quests/${quest.id}/enroll`, {
                        location: 11,
                        is_targeted: false,
                        metadata_sealed: null,
                        traffic_metadata_sealed: sealedFor(quest.id)
                    });
                } catch (e) {
                    Logger.log(`[Enroll] Enrollment failed: ${e.message}`, 'warn');
                }
            }

            if (typeData.type === "WATCH_VIDEO") await Tasks.VIDEO(quest, tInfo);
            else if (typeData.type === "GAME") await Tasks.GAME(quest, tInfo);
            else if (typeData.type === "STREAM") await Tasks.STREAM(quest, tInfo);
            else if (typeData.type === "ACTIVITY") await Tasks.ACTIVITY(quest, tInfo);

            if (RUNTIME.randomDelay && RUNTIME.running) {
                const delay = rnd(60000, 300000);
                Logger.log(`[AntiDetect] Sleeping ${(delay/60000).toFixed(1)}m before next task...`, 'info');
                await sleep(delay);
            }
        }

        Logger.log('[System] All selected quests processed!', 'success');
    }

    main().catch(err => {
        console.error('[Nova Fatal]', err);
        Logger.shutdown();
    });
})();