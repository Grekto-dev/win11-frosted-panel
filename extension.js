const Clutter       = imports.gi.Clutter;
const Gio           = imports.gi.Gio;
const GLib          = imports.gi.GLib;
const Meta          = imports.gi.Meta;
const St            = imports.gi.St;
const Main          = imports.ui.main;
const Panel         = imports.ui.panel;
const Settings      = imports.ui.settings;
const SignalManager = imports.misc.signalManager;
const Mainloop      = imports.mainloop;

const Effects       = require('./effects');

const DEFAULT_OPACITY_LEVEL = 0.60;

function scaleOpacity(base, level) {
    const raw = (typeof level === 'number' && Number.isFinite(level)) ? level : DEFAULT_OPACITY_LEVEL;
    const t = Math.max(0.0, Math.min(1.0, raw));
    if (Math.abs(t - DEFAULT_OPACITY_LEVEL) < 1e-6)
        return base;
    if (t < DEFAULT_OPACITY_LEVEL)
        return base * (t / DEFAULT_OPACITY_LEVEL);
    const k = (t - DEFAULT_OPACITY_LEVEL) / (1.0 - DEFAULT_OPACITY_LEVEL);
    return base + (1.0 - base) * k;
}

const PANEL_TRANSPARENT_STYLE =
    'background-color: transparent; ' +
    'background-gradient-direction: none; ' +
    'background-image: none; ' +
    'border-image: none; ' +
    'border-color: transparent; ' +
    'box-shadow: 0 0 transparent;';

const MENU_TRANSPARENT_STYLE =
    PANEL_TRANSPARENT_STYLE + ' border-radius: 8px;';

// Calibrated directly against Windows 11 VM taskbar measurements (Dark & Light modes)
const PRESETS = {
    'win11-dark': {
        lumColor: { r: 34 / 255, g: 34 / 255, b: 34 / 255 },
        lumOpacity: 0.90,
        tintColor: { r: 32 / 255, g: 32 / 255, b: 32 / 255 },
        tintOpacity: 0.60,
        saturation: 1.0,
        borderColor: { r: 118 / 255, g: 118 / 255, b: 118 / 255 },
        borderOpacity: 0.40,
    },
    'win11-light': {
        lumColor: { r: 230 / 255, g: 230 / 255, b: 230 / 255 },
        lumOpacity: 0.95,
        tintColor: { r: 245 / 255, g: 245 / 255, b: 245 / 255 },
        tintOpacity: 0.50,
        saturation: 1.0,
        borderColor: { r: 22 / 255, g: 22 / 255, b: 22 / 255 },
        borderOpacity: 0.22,
    },
};

// Calibrated directly against Windows 11 VM Start Menu Acrylic measurements
const MENU_PRESETS = {
    'win11-dark': {
        lumColor: { r: 30 / 255, g: 30 / 255, b: 30 / 255 },
        lumOpacity: 0.95,
        tintColor: { r: 60 / 255, g: 60 / 255, b: 60 / 255 },
        tintOpacity: 0.45,
        saturation: 1.0,
        borderColor: { r: 255 / 255, g: 255 / 255, b: 255 / 255 },
        borderOpacity: 0.14,
    },
    'win11-light': {
        lumColor: { r: 240 / 255, g: 240 / 255, b: 240 / 255 },
        lumOpacity: 0.90,
        tintColor: { r: 250 / 255, g: 250 / 255, b: 250 / 255 },
        tintOpacity: 0.45,
        saturation: 1.0,
        borderColor: { r: 0 / 255, g: 0 / 255, b: 0 / 255 },
        borderOpacity: 0.14,
    },
};

function parseColor(colorStr, fallback) {
    if (!colorStr)
        return fallback;
    try {
        const [ok, c] = Clutter.Color.from_string(colorStr);
        if (ok) {
            return {
                r: c.red / 255.0,
                g: c.green / 255.0,
                b: c.blue / 255.0,
            };
        }
    } catch (_e) {
        // Fallback below
    }
    return fallback;
}

function isWindowMaximized(metaWindow) {
    return metaWindow &&
        !metaWindow.minimized &&
        metaWindow.get_window_type() !== Meta.WindowType.DESKTOP &&
        metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH;
}

function getBorderEdge(panelPosition) {
    switch (panelPosition) {
        case Panel.PanelLoc.bottom:
            return 0.0; // top edge of bottom panel
        case Panel.PanelLoc.top:
            return 1.0; // bottom edge of top panel
        case Panel.PanelLoc.left:
            return 2.0; // right edge of left panel
        case Panel.PanelLoc.right:
            return 3.0; // left edge of right panel
        default:
            return 0.0;
    }
}

class Win11FrostedTaskbarManager {
    constructor(uuid) {
        this._uuid = uuid;
        this._panels = new Map();
        this._menus = new Map();
        this._menuScanIdleId = 0;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleFactor = this._themeContext.scale_factor;
        this._pillBox = new Clutter.ActorBox();
        this._signals = new SignalManager.SignalManager(null);
        this._maxSignals = new SignalManager.SignalManager(null);
        this._settings = new Settings.ExtensionSettings(this, uuid);
        this._bindSettings();
        this._initSystemThemeMonitors();
        this._syncLanguageLocale();

        this._origPanelEnable = Panel.Panel.prototype.enable;
        this._origPanelDisable = Panel.Panel.prototype.disable;
        const manager = this;

        Panel.Panel.prototype.enable = function(...args) {
            manager._origPanelEnable.apply(this, args);
            manager._onPanelEnableStateChanged(this, true);
        };
        Panel.Panel.prototype.disable = function(...args) {
            manager._origPanelDisable.apply(this, args);
            manager._onPanelEnableStateChanged(this, false);
        };

        this._signals.connect(global.settings, 'changed::panels-enabled', () => this._syncPanels());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => {
            this._syncPanels();
            this._updateAllMenus();
        });
        this._signals.connect(global.display, 'in-fullscreen-changed', () => this._updateAllPanels());
        this._signals.connect(this._themeContext, 'notify::scale-factor', () => {
            this._scaleFactor = this._themeContext.scale_factor;
            this._updateAllPanels();
            this._updateAllMenus();
        });
        if (Main.deskletContainer && Main.deskletContainer.actor) {
            this._signals.connect(Main.deskletContainer.actor, 'actor-added', () => this._syncAllDeskletClones());
            this._signals.connect(Main.deskletContainer.actor, 'actor-removed', () => this._syncAllDeskletClones());
        }
        this._signals.connect(Main.uiGroup, 'actor-added', (_group, actor) => this._onUiGroupActorAdded(actor));

        this._syncMaximizeSignals();
        this._syncPanels();
        this._syncMenus();
    }

    _bindSettings() {
        const keys = [
            'language',
            'preset',
            'opacity-level',
            'adapt-light-text',
            'style-panel-buttons',
            'blur-radius',
            'luminosity-opacity',
            'luminosity-color',
            'tint-opacity',
            'tint-color',
            'noise-intensity',
            'saturation',
            'show-border',
            'border-color',
            'border-opacity',
            'blur-start-menu',
            'blur-windows',
            'keep-frosted-maximized',
            'opaque-fallback-color',
        ];
        this._prefs = {};
        for (const key of keys) {
            const prop = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
            this._settings.bind(key, prop, () => this._onSettingsChanged(key), null);
            // ExtensionSettings writes directly onto `this[prop]`
            Object.defineProperty(this._prefs, prop, {
                get: () => this[prop],
                enumerable: true,
            });
        }
    }

    _initSystemThemeMonitors() {
        this._cinnamonThemeSettings = null;
        this._interfaceSettings = null;
        this._gnomeInterfaceSettings = null;

        const schemaSource = Gio.SettingsSchemaSource.get_default();
        if (!schemaSource)
            return;

        const onThemeChanged = () => {
            if (this._prefs.preset === 'system') {
                this._refreshAllStyles();
                this._updateAllPanels();
                this._updateAllMenus();
            }
        };

        const cinThemeSchema = schemaSource.lookup('org.cinnamon.theme', true);
        if (cinThemeSchema && cinThemeSchema.has_key('name')) {
            this._cinnamonThemeSettings = new Gio.Settings({ schema_id: 'org.cinnamon.theme' });
            this._signals.connect(this._cinnamonThemeSettings, 'changed::name', onThemeChanged);
        }

        const cinIfaceSchema = schemaSource.lookup('org.cinnamon.desktop.interface', true);
        if (cinIfaceSchema && cinIfaceSchema.has_key('gtk-theme')) {
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.interface' });
            this._signals.connect(this._interfaceSettings, 'changed::gtk-theme', onThemeChanged);
        }

        const gnomeIfaceSchema = schemaSource.lookup('org.gnome.desktop.interface', true);
        if (gnomeIfaceSchema && gnomeIfaceSchema.has_key('color-scheme')) {
            this._gnomeInterfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            this._signals.connect(this._gnomeInterfaceSettings, 'changed::color-scheme', onThemeChanged);
        }
    }

    _isSystemDark() {
        const darkRe = /(dark|black|noir|night)/i;

        if (this._cinnamonThemeSettings) {
            const cinTheme = (this._cinnamonThemeSettings.get_string('name') || '').trim();
            if (darkRe.test(cinTheme))
                return true;
            if (cinTheme.length && cinTheme.toLowerCase() !== 'cinnamon')
                return false;
        }

        if (this._interfaceSettings) {
            const gtkTheme = (this._interfaceSettings.get_string('gtk-theme') || '').trim();
            if (darkRe.test(gtkTheme))
                return true;
            if (gtkTheme.length)
                return false;
        }

        if (this._gnomeInterfaceSettings) {
            const scheme = (this._gnomeInterfaceSettings.get_string('color-scheme') || '').trim();
            if (scheme === 'prefer-light')
                return false;
            if (scheme === 'prefer-dark')
                return true;
        }

        return true;
    }

    _getEffectivePreset() {
        if (this._prefs.preset === 'system')
            return this._isSystemDark() ? 'win11-dark' : 'win11-light';
        return this._prefs.preset;
    }

    _syncLanguageLocale() {
        if (!_extensionMeta || !_extensionMeta.path)
            return;
        const userMoPath = GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'share', 'locale', 'pt_BR', 'LC_MESSAGES', `${this._uuid}.mo`,
        ]);
        const userMoFile = Gio.File.new_for_path(userMoPath);
        const wantPtBr = this._prefs.language === 'ptbr';

        try {
            if (wantPtBr) {
                const srcMoPath = GLib.build_filenamev([
                    _extensionMeta.path, 'locale', 'pt_BR', 'LC_MESSAGES', `${this._uuid}.mo`,
                ]);
                const srcFile = Gio.File.new_for_path(srcMoPath);
                if (!srcFile.query_exists(null))
                    return;
                const parentDir = userMoFile.get_parent();
                if (parentDir && !parentDir.query_exists(null))
                    parentDir.make_directory_with_parents(null);
                srcFile.copy(userMoFile, Gio.FileCopyFlags.OVERWRITE, null, null);
            } else if (userMoFile.query_exists(null)) {
                userMoFile.delete(null);
            }
        } catch (e) {
            global.logWarning(`${this._uuid}: failed to sync locale: ${e}`);
        }
    }

    _onSettingsChanged(key) {
        if (key === 'language') {
            this._syncLanguageLocale();
            return;
        }
        if (key === 'keep-frosted-maximized') {
            this._syncMaximizeSignals();
        }
        if (key === 'blur-windows') {
            for (const entry of this._panels.values()) {
                this._syncWindowClone(entry);
            }
        }
        if (key === 'blur-start-menu') {
            this._syncMenus();
        }
        this._refreshAllStyles();
        this._updateAllPanels();
        this._updateAllMenus();
    }

    _getEffectConfig(presetsMap = PRESETS) {
        const p = this._prefs;
        const effectivePreset = this._getEffectivePreset();
        const presetData = presetsMap[effectivePreset];
        if (presetData) {
            return {
                blurRadius: p.blurRadius,
                noiseIntensity: p.noiseIntensity,
                showBorder: p.showBorder,
                lumColor: presetData.lumColor,
                lumOpacity: scaleOpacity(presetData.lumOpacity, p.opacityLevel),
                tintColor: presetData.tintColor,
                tintOpacity: scaleOpacity(presetData.tintOpacity, p.opacityLevel),
                saturation: presetData.saturation,
                borderColor: presetData.borderColor,
                borderOpacity: presetData.borderOpacity,
            };
        }
        return {
            blurRadius: p.blurRadius,
            noiseIntensity: p.noiseIntensity,
            showBorder: p.showBorder,
            lumColor: parseColor(p.luminosityColor, presetsMap['win11-dark'].lumColor),
            lumOpacity: p.luminosityOpacity,
            tintColor: parseColor(p.tintColor, presetsMap['win11-dark'].tintColor),
            tintOpacity: p.tintOpacity,
            saturation: p.saturation,
            borderColor: parseColor(p.borderColor, presetsMap['win11-dark'].borderColor),
            borderOpacity: p.borderOpacity,
        };
    }

    _syncMaximizeSignals() {
        this._maxSignals.disconnectAllSignals();
        if (!this._prefs.keepFrostedMaximized) {
            const refreshMax = () => this._refreshMaximizeState();
            this._maxSignals.connect(global.window_manager, 'size-change', refreshMax);
            this._maxSignals.connect(global.window_manager, 'minimize', refreshMax);
            this._maxSignals.connect(global.window_manager, 'unminimize', refreshMax);
            this._maxSignals.connect(global.window_manager, 'destroy', refreshMax);
            this._maxSignals.connect(global.window_manager, 'switch-workspace', refreshMax);
            this._maxSignals.connect(global.screen, 'window-added', () => {
                Mainloop.idle_add(() => {
                    this._refreshMaximizeState();
                    return false;
                });
            });
            this._maxSignals.connect(global.screen, 'window-workspace-changed', refreshMax);
        }
        this._refreshMaximizeState();
    }

    _monitorHasMaximizedWindow(monitorIndex) {
        if (this._prefs.keepFrostedMaximized)
            return false;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws)
            return false;
        return ws.list_windows().some(
            w => w.get_monitor() === monitorIndex && isWindowMaximized(w)
        );
    }

    _refreshMaximizeState() {
        for (const entry of this._panels.values()) {
            const opaque = this._monitorHasMaximizedWindow(entry.panel.monitorIndex);
            if (entry.opaqueDueToMaximize !== opaque) {
                entry.opaqueDueToMaximize = opaque;
                this._applyPanelStyle(entry);
                this._updatePanel(entry);
            }
        }
    }

    _syncPanels() {
        const activePanels = new Set(Main.getPanels().filter(Boolean));

        for (const panel of Array.from(this._panels.keys())) {
            if (!activePanels.has(panel)) {
                this._teardownPanel(panel);
            }
        }

        for (const panel of activePanels) {
            if (!this._panels.has(panel)) {
                this._setupPanel(panel);
            }
        }

        this._refreshMaximizeState();
        this._updateAllPanels();
    }

    _createSceneBackdrop() {
        const viewport = new St.Group({
            clip_to_allocation: true,
            reactive: false,
            visible: false,
        });
        const scene = new Clutter.Actor({ reactive: false });

        let wallpaper = null;
        if (!Meta.is_wayland_compositor()) {
            wallpaper = Meta.X11BackgroundActor.new_for_display(global.display);
            scene.add_child(wallpaper);
        }

        let deskletClone = null;
        if (this._hasDesklets()) {
            deskletClone = new Clutter.Clone({
                source: Main.deskletContainer.actor,
                reactive: false,
            });
            scene.add_child(deskletClone);
        }

        viewport.add_child(scene);
        return {
            viewport,
            scene,
            wallpaper,
            deskletClone,
            windowClone: null,
            effectChain: new Effects.FrostedEffectChain(viewport),
        };
    }

    _hasDesklets() {
        return !!(Main.deskletContainer &&
            Main.deskletContainer.actor &&
            Main.deskletContainer.actor.get_n_children() > 0);
    }

    _syncEntryDeskletClone(entry) {
        if (!entry.scene)
            return;
        const hasDesklets = this._hasDesklets();
        if (hasDesklets && !entry.deskletClone) {
            entry.deskletClone = new Clutter.Clone({
                source: Main.deskletContainer.actor,
                reactive: false,
            });
            // Keep above wallpaper, below windows
            if (entry.wallpaper && entry.wallpaper.get_parent() === entry.scene)
                entry.scene.insert_child_above(entry.deskletClone, entry.wallpaper);
            else
                entry.scene.insert_child_at_index(entry.deskletClone, 0);
        } else if (!hasDesklets && entry.deskletClone) {
            if (entry.deskletClone.get_parent() === entry.scene)
                entry.scene.remove_child(entry.deskletClone);
            entry.deskletClone.destroy();
            entry.deskletClone = null;
        }
    }

    _syncAllDeskletClones() {
        for (const entry of this._panels.values())
            this._syncEntryDeskletClone(entry);
        for (const entry of this._menus.values())
            this._syncEntryDeskletClone(entry);
    }

    _destroySceneBackdrop(entry) {
        if (entry.effectChain) {
            entry.effectChain.destroy();
            entry.effectChain = null;
        }

        if (entry.windowClone) {
            entry.scene.remove_child(entry.windowClone);
            entry.windowClone.destroy();
            entry.windowClone = null;
        }
        if (entry.deskletClone) {
            entry.scene.remove_child(entry.deskletClone);
            entry.deskletClone.destroy();
            entry.deskletClone = null;
        }
        if (entry.wallpaper) {
            entry.scene.remove_child(entry.wallpaper);
            entry.wallpaper.destroy();
            entry.wallpaper = null;
        }
        if (entry.viewport) {
            if (entry.viewport.get_parent()) {
                entry.viewport.get_parent().remove_child(entry.viewport);
            }
            entry.viewport.destroy();
            entry.viewport = null;
        }
        entry.scene = null;
    }

    _setupPanel(panel) {
        const actor = panel.actor;
        const backdrop = this._createSceneBackdrop();
        global.overlay_group.insert_child_at_index(backdrop.viewport, 0);

        const entry = {
            panel,
            actor,
            ...backdrop,
            panelSignals: new SignalManager.SignalManager(null),
            containerSignals: new Map(),
            buttonSignalIds: new Map(),
            adjustedButtons: new Set(),
            buttonIndicators: new Map(),
            originalColor: actor.get_background_color(),
            externalStyle: actor.get_style() || '',
            setStyleWrapped: false,
            opaqueDueToMaximize: this._monitorHasMaximizedWindow(panel.monitorIndex),
            reclipId: 0,
        };

        this._panels.set(panel, entry);
        this._syncWindowClone(entry);
        this._wrapPanelSetStyle(entry);
        this._watchPanelButtons(entry);
        this._applyPanelStyle(entry);

        entry.panelSignals.connect(actor, 'notify::allocation', () => this._updatePanel(entry));
        entry.panelSignals.connect(actor, 'notify::height', () => this._syncTaskbarButtonHeights(entry));
        entry.panelSignals.connect(actor, 'notify::visible', () => this._updatePanel(entry));
        entry.panelSignals.connect(actor, 'notify::opacity', () => this._updatePanel(entry));
        entry.panelSignals.connect(actor, 'notify::scale-x', () => this._updatePanel(entry));
        entry.panelSignals.connect(actor, 'notify::scale-y', () => this._updatePanel(entry));
        entry.panelSignals.connect(actor, 'style-changed', () => this._updatePanel(entry));
        entry.panelSignals.connect(actor, 'destroy', () => this._teardownPanel(panel));

        entry.reclipId = Mainloop.timeout_add(500, () => {
            entry.reclipId = 0;
            if (this._panels.has(panel))
                this._updatePanel(entry);
            return false;
        });

        this._updatePanel(entry);
    }

    _syncWindowClone(entry) {
        if (this._prefs.blurWindows) {
            if (!entry.windowClone) {
                entry.windowClone = new Clutter.Clone({
                    source: global.window_group,
                    reactive: false,
                });
                entry.scene.add_child(entry.windowClone);
            }
        } else if (entry.windowClone) {
            entry.scene.remove_child(entry.windowClone);
            entry.windowClone.destroy();
            entry.windowClone = null;
        }
    }

    _wrapPanelSetStyle(entry) {
        if (entry.setStyleWrapped)
            return;
        const actor = entry.actor;
        entry.setStyleWrapped = true;
        actor.set_style = (style) => {
            if (this._panels.has(entry.panel)) {
                entry.externalStyle = style || '';
                this._applyPanelStyle(entry);
            } else {
                St.Widget.prototype.set_style.call(actor, style);
            }
        };
    }

    _unwrapPanelSetStyle(entry) {
        if (!entry.setStyleWrapped)
            return;
        delete entry.actor.set_style;
        entry.setStyleWrapped = false;
    }

    _setStyleClass(actor, className, enabled) {
        if (!actor)
            return;
        const hasClass = actor.has_style_class_name(className);
        if (enabled && !hasClass) {
            actor.add_style_class_name(className);
        } else if (!enabled && hasClass) {
            actor.remove_style_class_name(className);
        }
    }

    _isTaskbarButton(actor) {
        return actor &&
            typeof actor.has_style_class_name === 'function' &&
            actor.has_style_class_name('grouped-window-list-item-box') &&
            !actor.has_style_class_name('win11-start-button') &&
            !actor.has_style_class_name('win11-search-panel-icon-btn');
    }

    _watchContainer(entry, container) {
        if (!container || entry.containerSignals.has(container))
            return;
        const ids = [
            container.connect('actor-added', (_parent, child) => {
                this._scanButtonSubtree(entry, child);
                this._syncTaskbarButtonHeights(entry);
            }),
            container.connect('destroy', () => {
                entry.containerSignals.delete(container);
            }),
        ];
        entry.containerSignals.set(container, ids);
    }

    _trackButtonActor(entry, btn) {
        if (!this._isTaskbarButton(btn) || entry.adjustedButtons.has(btn))
            return;
        entry.adjustedButtons.add(btn);
        this._watchContainer(entry, btn.get_parent());

        const pill = new St.Widget({
            name: 'win11Indicator',
            style_class: 'win11-taskbar-indicator',
            reactive: false,
            visible: false,
        });
        entry.buttonIndicators.set(btn, pill);
        btn.add_child(pill);

        const cbox = this._pillBox;
        const ids = [
            btn.connect('notify::height', () => {
                if (!btn._win11Adjusting)
                    this._applyButtonHeight(entry, btn);
            }),
            btn.connect('style-changed', () => {
                if (!btn._win11Adjusting) {
                    this._applyButtonHeight(entry, btn);
                    this._syncButtonIndicator(entry, btn);
                }
            }),
            btn.connect('allocate', (_actor, box, flags) => {
                const ind = entry.buttonIndicators.get(btn);
                if (!ind || !ind.visible)
                    return;
                const [_minW, natW] = ind.get_preferred_width(-1);
                const [_minH, natH] = ind.get_preferred_height(-1);
                const pillW = Math.max(1, Math.round(natW));
                const pillH = Math.max(1, Math.round(natH));
                const w = box.x2 - box.x1;
                const h = box.y2 - box.y1;
                if (btn.has_style_class_name('left')) {
                    cbox.x1 = box.x1 + 1;
                    cbox.x2 = cbox.x1 + pillW;
                    cbox.y1 = box.y1 + Math.floor((h - pillH) / 2);
                    cbox.y2 = cbox.y1 + pillH;
                } else if (btn.has_style_class_name('right')) {
                    cbox.x2 = box.x2 - 1;
                    cbox.x1 = cbox.x2 - pillW;
                    cbox.y1 = box.y1 + Math.floor((h - pillH) / 2);
                    cbox.y2 = cbox.y1 + pillH;
                } else if (btn.has_style_class_name('top')) {
                    cbox.x1 = box.x1 + Math.floor((w - pillW) / 2);
                    cbox.x2 = cbox.x1 + pillW;
                    cbox.y1 = box.y1 + 1;
                    cbox.y2 = cbox.y1 + pillH;
                } else {
                    cbox.x1 = box.x1 + Math.floor((w - pillW) / 2);
                    cbox.x2 = cbox.x1 + pillW;
                    cbox.y2 = box.y2 - 1;
                    cbox.y1 = cbox.y2 - pillH;
                }
                ind.allocate(cbox, flags);
            }),
            btn.connect('destroy', () => {
                entry.adjustedButtons.delete(btn);
                entry.buttonIndicators.delete(btn);
                entry.buttonSignalIds.delete(btn);
            }),
        ];
        entry.buttonSignalIds.set(btn, ids);
        this._syncButtonIndicator(entry, btn);
    }

    _syncButtonIndicator(entry, btn, forceActive = null) {
        const ind = entry.buttonIndicators.get(btn);
        if (!ind)
            return;
        const active = forceActive !== null
            ? forceActive
            : (!entry.opaqueDueToMaximize && this._prefs.stylePanelButtons);
        const isRunningOrFocused = btn.has_style_pseudo_class('active') ||
            btn.has_style_pseudo_class('focus') ||
            btn.has_style_pseudo_class('checked');
        const shouldShow = active && isRunningOrFocused;
        if (ind.visible !== shouldShow) {
            ind.visible = shouldShow;
            btn.queue_relayout();
        }
    }

    _scanButtonSubtree(entry, root) {
        if (!root)
            return;
        if (this._isTaskbarButton(root)) {
            this._trackButtonActor(entry, root);
            return;
        }
        const children = root.get_children ? root.get_children() : [];
        for (const child of children) {
            this._scanButtonSubtree(entry, child);
        }
    }

    _watchPanelButtons(entry) {
        const { panel } = entry;
        for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
            this._watchContainer(entry, box);
            this._scanButtonSubtree(entry, box);
        }
    }

    _applyButtonHeight(entry, btn, forceActive = null) {
        if (!btn)
            return;
        const isHorizontal = btn.has_style_class_name('bottom') || btn.has_style_class_name('top');
        if (!isHorizontal)
            return;

        const active = forceActive !== null
            ? forceActive
            : (!entry.opaqueDueToMaximize && this._prefs.stylePanelButtons);
        const panelH = Math.round(entry.actor.height);
        if (panelH <= 0)
            return;
        const target = active ? Math.max(24, panelH - 6) : panelH;
        if (Math.round(btn.height) === target)
            return;

        btn._win11Adjusting = true;
        try {
            btn.height = target;
        } finally {
            btn._win11Adjusting = false;
        }
    }

    _syncTaskbarButtonHeights(entry, forceActive = null) {
        for (const btn of Array.from(entry.adjustedButtons)) {
            try {
                this._applyButtonHeight(entry, btn, forceActive);
                this._syncButtonIndicator(entry, btn, forceActive);
            } catch (_e) {
                entry.adjustedButtons.delete(btn);
            }
        }
    }

    _syncPanelStyleClasses(entry) {
        const frostedActive = !entry.opaqueDueToMaximize;
        const isLight = this._getEffectivePreset() === 'win11-light';
        const styleButtons = frostedActive && this._prefs.stylePanelButtons;

        this._setStyleClass(entry.actor, 'win11-frosted-panel', frostedActive);
        this._setStyleClass(entry.actor, 'win11-frosted-panel-light', frostedActive && isLight);
        this._setStyleClass(entry.actor, 'win11-frosted-buttons', styleButtons);
        this._syncTaskbarButtonHeights(entry);
    }

    _applyPanelStyle(entry) {
        this._syncPanelStyleClasses(entry);

        let style = entry.externalStyle || '';
        if (style.length && !style.trim().endsWith(';'))
            style += ';';

        if (entry.opaqueDueToMaximize) {
            const c = parseColor(this._prefs.opaqueFallbackColor, { r: 32 / 255, g: 32 / 255, b: 32 / 255 });
            const r = Math.round(c.r * 255);
            const g = Math.round(c.g * 255);
            const b = Math.round(c.b * 255);
            style += (style.length ? ' ' : '') +
                `background-color: rgb(${r}, ${g}, ${b}); background-gradient-direction: none; background-image: none; border-image: none; box-shadow: 0 0 transparent;`;
        } else {
            style += (style.length ? ' ' : '') + PANEL_TRANSPARENT_STYLE;
            if (this._getEffectivePreset() === 'win11-light' && this._prefs.adaptLightText) {
                style += ' color: #1f1f1f;';
            }
        }
        St.Widget.prototype.set_style.call(entry.actor, style.length ? style : null);
    }

    _refreshAllStyles() {
        for (const entry of this._panels.values()) {
            this._applyPanelStyle(entry);
        }
        for (const entry of this._menus.values()) {
            this._applyMenuStyle(entry);
        }
    }

    _updateFrostedViewport(entry, ax, ay, aw, ah, mon, config, cornerOpts) {
        const { actor, viewport, scene } = entry;
        const visStageX1 = Math.max(mon.x, ax);
        const visStageY1 = Math.max(mon.y, ay);
        const visStageX2 = Math.min(mon.x + mon.width, ax + aw);
        const visStageY2 = Math.min(mon.y + mon.height, ay + ah);
        const visW = visStageX2 - visStageX1;
        const visH = visStageY2 - visStageY1;
        if (visW <= 0 || visH <= 0) {
            if (viewport.visible)
                viewport.hide();
            return false;
        }

        const scaleFactor = this._scaleFactor;
        const margin = Effects.computeBlurMargin(config.blurRadius, scaleFactor);

        const vpX = Math.max(mon.x, Math.floor(visStageX1 - margin));
        const vpY = Math.max(mon.y, Math.floor(visStageY1 - margin));
        const vpX2 = Math.min(mon.x + mon.width, Math.ceil(visStageX2 + margin));
        const vpY2 = Math.min(mon.y + mon.height, Math.ceil(visStageY2 + margin));
        const vpW = Math.max(1, vpX2 - vpX);
        const vpH = Math.max(1, vpY2 - vpY);

        if (viewport.x !== vpX || viewport.y !== vpY)
            viewport.set_position(vpX, vpY);
        if (viewport.width !== vpW || viewport.height !== vpH)
            viewport.set_size(vpW, vpH);
        const targetSceneX = -vpX;
        const targetSceneY = -vpY;
        const stageW = global.stage.width;
        const stageH = global.stage.height;
        if (scene.x !== targetSceneX || scene.y !== targetSceneY)
            scene.set_position(targetSceneX, targetSceneY);
        if (scene.width !== stageW || scene.height !== stageH)
            scene.set_size(stageW, stageH);

        const opacity = (actor.scale_x === 0 || actor.scale_y === 0) ? 0 : actor.opacity;
        if (viewport.opacity !== opacity)
            viewport.opacity = opacity;

        let rect = entry._vpRect;
        if (!rect) {
            rect = {};
            entry._vpRect = rect;
        }
        rect.vpX = vpX;
        rect.vpY = vpY;
        rect.vpW = vpW;
        rect.vpH = vpH;
        rect.visX = visStageX1 - vpX;
        rect.visY = visStageY1 - vpY;
        rect.visW = visW;
        rect.visH = visH;
        rect.cornerRadius = cornerOpts.cornerRadius;
        rect.cornersTop = cornerOpts.cornersTop;
        rect.cornersBottom = cornerOpts.cornersBottom;
        rect.borderEdge = cornerOpts.borderEdge;

        entry.effectChain.update(config, rect, scaleFactor);
        if (!viewport.visible)
            viewport.show();
        return true;
    }

    _onPanelEnableStateChanged(panel, _enabled) {
        const entry = this._panels.get(panel);
        if (entry)
            this._updatePanel(entry);
    }

    _updateAllPanels() {
        for (const entry of this._panels.values()) {
            this._updatePanel(entry);
        }
    }

    _updatePanel(entry) {
        const { panel, actor, viewport } = entry;
        if (!actor || !viewport)
            return;

        if (!actor.visible ||
            panel._disabled ||
            entry.opaqueDueToMaximize ||
            global.display.get_monitor_in_fullscreen(panel.monitorIndex)) {
            if (viewport.visible)
                viewport.hide();
            return;
        }

        const px = actor.x;
        const py = actor.y;
        const pw = actor.width;
        const ph = actor.height;
        if (pw <= 0 || ph <= 0) {
            if (viewport.visible)
                viewport.hide();
            return;
        }

        const mon = panel.monitor ||
            Main.layoutManager.monitors[panel.monitorIndex] ||
            { x: 0, y: 0, width: global.stage.width, height: global.stage.height };

        let topRadius = 0;
        let bottomRadius = 0;
        const themeNode = actor.get_stage() ? actor.get_theme_node() : null;
        if (themeNode) {
            topRadius = themeNode.get_border_radius(St.Corner.TOPLEFT);
            bottomRadius = themeNode.get_border_radius(St.Corner.BOTTOMLEFT);
        }

        this._updateFrostedViewport(entry, px, py, pw, ph, mon, this._getEffectConfig(PRESETS), {
            cornerRadius: Math.max(topRadius, bottomRadius),
            cornersTop: topRadius > 0,
            cornersBottom: bottomRadius > 0,
            borderEdge: getBorderEdge(panel.panelPosition),
        });
    }

    _teardownPanel(panel) {
        const entry = this._panels.get(panel);
        if (!entry)
            return;
        this._panels.delete(panel);

        if (entry.reclipId) {
            Mainloop.source_remove(entry.reclipId);
            entry.reclipId = 0;
        }
        entry.panelSignals.disconnectAllSignals();
        for (const [container, ids] of entry.containerSignals.entries()) {
            try {
                if (!container.is_finalized()) {
                    for (const id of ids)
                        container.disconnect(id);
                }
            } catch (_e) {
                // Container may already be destroyed
            }
        }
        entry.containerSignals.clear();
        for (const [btn, ids] of entry.buttonSignalIds.entries()) {
            try {
                if (!btn.is_finalized()) {
                    for (const id of ids)
                        btn.disconnect(id);
                }
            } catch (_e) {
                // Button may already be destroyed
            }
        }
        entry.buttonSignalIds.clear();
        this._syncTaskbarButtonHeights(entry, false);
        for (const [btn, ind] of entry.buttonIndicators.entries()) {
            try {
                if (ind.get_parent() === btn)
                    btn.remove_child(ind);
                ind.destroy();
            } catch (_e) {
                // Button may already be destroyed
            }
        }
        entry.buttonIndicators.clear();
        entry.adjustedButtons.clear();
        this._unwrapPanelSetStyle(entry);

        try {
            this._setStyleClass(entry.actor, 'win11-frosted-panel', false);
            this._setStyleClass(entry.actor, 'win11-frosted-panel-light', false);
            this._setStyleClass(entry.actor, 'win11-frosted-buttons', false);
            entry.actor.set_background_color(entry.originalColor);
            entry.actor.set_style(entry.externalStyle || null);
        } catch (_e) {
            // Actor may already be destroyed
        }

        this._destroySceneBackdrop(entry);
    }

    _isStartMenuActor(actor) {
        if (!actor || !(actor instanceof St.Widget))
            return false;
        return actor.has_style_class_name('menu') &&
            actor.has_style_class_name('appmenu-background');
    }

    _onUiGroupActorAdded(actor) {
        if (!this._prefs.blurStartMenu || !(actor instanceof St.Widget))
            return;
        if (this._isStartMenuActor(actor)) {
            if (!this._menus.has(actor))
                this._setupMenu(actor);
            return;
        }
        // AppletPopupMenu adds menu.actor before setCustomStyleClass('appmenu-background') runs
        if (actor.has_style_class_name('menu') && !this._menuScanIdleId) {
            this._menuScanIdleId = Mainloop.idle_add(() => {
                this._menuScanIdleId = 0;
                this._syncMenus();
                return false;
            });
        }
    }

    _syncMenus() {
        if (!this._prefs.blurStartMenu) {
            for (const actor of Array.from(this._menus.keys())) {
                this._teardownMenu(actor);
            }
            return;
        }
        for (const child of Main.uiGroup.get_children()) {
            if (this._isStartMenuActor(child) && !this._menus.has(child)) {
                this._setupMenu(child);
            }
        }
    }

    _setupMenu(actor) {
        const entry = {
            actor,
            shadow: null,
            viewport: null,
            scene: null,
            wallpaper: null,
            deskletClone: null,
            windowClone: null,
            effectChain: null,
            menuSignals: new SignalManager.SignalManager(null),
            backdropSignals: null,
            globalCloneSignals: new SignalManager.SignalManager(null),
            windowCloneItems: [],
            windowClonesActive: false,
            originalStyle: actor.get_style() || '',
            stackIdleId: 0,
        };

        this._menus.set(actor, entry);
        this._applyMenuStyle(entry);

        entry.menuSignals.connect(actor, 'notify::visible', () => {
            if (actor.visible && this._prefs.blurStartMenu) {
                this._ensureMenuBackdrop(entry);
                this._syncMenuStacking(entry);
            }
            this._updateMenu(entry);
            // Re-sync after PopupMenu.open finishes sibling restacking and layout
            if (actor.visible && this._prefs.blurStartMenu && !entry.stackIdleId) {
                entry.stackIdleId = Mainloop.idle_add(() => {
                    entry.stackIdleId = 0;
                    if (this._menus.has(actor) && actor.visible) {
                        this._syncMenuStacking(entry);
                        this._updateMenu(entry);
                    }
                    return false;
                });
            }
        });
        entry.menuSignals.connect(actor, 'destroy', () => this._teardownMenu(actor));

        if (actor.visible && this._prefs.blurStartMenu) {
            this._ensureMenuBackdrop(entry);
            this._updateMenu(entry);
        }
    }

    _ensureMenuBackdrop(entry) {
        if (entry.viewport)
            return;

        const { actor } = entry;
        const parent = actor.get_parent() || Main.uiGroup;
        const backdrop = this._createSceneBackdrop();
        const shadow = new St.Widget({
            style_class: 'win11-frosted-menu-shadow',
            reactive: false,
            visible: false,
        });

        parent.add_child(shadow);
        parent.add_child(backdrop.viewport);

        Object.assign(entry, backdrop, { shadow });
        this._applyMenuStyle(entry);

        entry.backdropSignals = new SignalManager.SignalManager(null);
        const queueUpdate = () => this._updateMenu(entry);
        entry.backdropSignals.connect(actor, 'notify::mapped', queueUpdate);
        entry.backdropSignals.connect(actor, 'notify::allocation', queueUpdate);
        entry.backdropSignals.connect(actor, 'notify::x', queueUpdate);
        entry.backdropSignals.connect(actor, 'notify::y', queueUpdate);
        entry.backdropSignals.connect(actor, 'notify::width', queueUpdate);
        entry.backdropSignals.connect(actor, 'notify::height', queueUpdate);
        entry.backdropSignals.connect(actor, 'notify::opacity', queueUpdate);
        entry.backdropSignals.connect(actor, 'notify::scale-x', queueUpdate);
        entry.backdropSignals.connect(actor, 'notify::scale-y', queueUpdate);
        entry.backdropSignals.connect(actor, 'parent-set', () => {
            this._syncMenuStacking(entry);
            this._updateMenu(entry);
        });
    }

    _applyMenuStyle(entry) {
        const isLight = this._getEffectivePreset() === 'win11-light';
        const active = this._prefs.blurStartMenu;

        this._setStyleClass(entry.actor, 'win11-frosted-start-menu', active);
        this._setStyleClass(entry.actor, 'win11-frosted-start-menu-light', active && isLight);
        if (entry.shadow)
            this._setStyleClass(entry.shadow, 'win11-frosted-menu-shadow-light', active && isLight);

        if (active) {
            let style = entry.originalStyle || '';
            if (style.length && !style.trim().endsWith(';'))
                style += ';';
            style += (style.length ? ' ' : '') + MENU_TRANSPARENT_STYLE;
            entry.actor.set_style(style);
        } else {
            entry.actor.set_style(entry.originalStyle || null);
        }
    }

    _syncMenuStacking(entry) {
        const { actor, viewport, shadow } = entry;
        if (!viewport || !shadow)
            return;
        const parent = actor.get_parent();
        if (!parent)
            return;

        for (const helper of [shadow, viewport]) {
            if (helper.get_parent() !== parent) {
                if (helper.get_parent())
                    helper.get_parent().remove_child(helper);
                parent.add_child(helper);
            }
        }

        const children = parent.get_children();
        const actorIdx = children.indexOf(actor);
        const vpIdx = children.indexOf(viewport);
        const shadowIdx = children.indexOf(shadow);
        if (actorIdx < 0)
            return;

        if (vpIdx !== actorIdx - 1)
            parent.set_child_below_sibling(viewport, actor);
        if (shadowIdx !== vpIdx - 1 || vpIdx !== actorIdx - 1)
            parent.set_child_below_sibling(shadow, viewport);
    }

    _getMonitorForRect(x, y, w, h) {
        const cx = x + w * 0.5;
        const cy = y + h * 0.5;
        for (const m of Main.layoutManager.monitors) {
            if (cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height)
                return m;
        }
        return Main.layoutManager.primaryMonitor ||
            Main.layoutManager.monitors[0] ||
            { x: 0, y: 0, width: global.stage.width, height: global.stage.height };
    }

    _updateAllMenus() {
        for (const entry of this._menus.values()) {
            this._updateMenu(entry);
        }
    }

    _clearMenuWindowClones(entry) {
        if (entry.globalCloneSignals)
            entry.globalCloneSignals.disconnectAllSignals();
        if (entry.windowCloneItems) {
            for (const item of entry.windowCloneItems) {
                try {
                    if (item.wa && !item.wa.is_finalized()) {
                        for (const id of item.sigIds)
                            item.wa.disconnect(id);
                    }
                } catch (_e) {
                    // WindowActor may already be finalized
                }
                if (item.clone.get_parent() === entry.scene)
                    entry.scene.remove_child(item.clone);
                item.clone.destroy();
            }
            entry.windowCloneItems = [];
        }
    }

    _syncMenuWindowClones(entry, mon, rx, ry, rw, rh) {
        this._clearMenuWindowClones(entry);
        if (!entry.scene)
            return;

        const rebuild = () => {
            if (!this._menus.has(entry.actor) || !entry.actor.visible)
                return;
            const [ax, ay] = entry.actor.get_transformed_position();
            const [aw, ah] = entry.actor.get_transformed_size();
            if (aw > 0 && ah > 0)
                this._syncMenuWindowClones(entry, this._getMonitorForRect(ax, ay, aw, ah), ax, ay, aw, ah);
        };
        entry.globalCloneSignals.connect(global.display, 'restacked', rebuild);
        entry.globalCloneSignals.connect(global.screen, 'window-added', rebuild);
        entry.globalCloneSignals.connect(global.screen, 'window-removed', rebuild);

        const pad = 64;
        const minX = Math.max(mon.x, rx - pad);
        const minY = Math.max(mon.y, ry - pad);
        const maxX = Math.min(mon.x + mon.width, rx + rw + pad);
        const maxY = Math.min(mon.y + mon.height, ry + rh + pad);

        // Clone individual MetaWindowActors (MetaWindowGroup clones cull to 0x0 offscreen)
        for (const wa of global.get_window_actors()) {
            const mw = wa.meta_window;
            if (!mw || !wa.visible || !mw.showing_on_its_workspace() || mw.minimized)
                continue;
            const wtype = mw.get_window_type();
            if (wtype === Meta.WindowType.DESKTOP ||
                wtype === Meta.WindowType.DOCK ||
                wtype === Meta.WindowType.SPLASHSCREEN)
                continue;
            if (wa.width <= 1 || wa.height <= 1)
                continue;
            if (wa.x + wa.width <= minX || wa.x >= maxX || wa.y + wa.height <= minY || wa.y >= maxY)
                continue;

            const clone = new Clutter.Clone({
                source: wa,
                reactive: false,
            });
            const syncGeom = () => {
                if (clone.x !== wa.x || clone.y !== wa.y)
                    clone.set_position(wa.x, wa.y);
                if (clone.width !== wa.width || clone.height !== wa.height)
                    clone.set_size(wa.width, wa.height);
                if (clone.opacity !== wa.opacity)
                    clone.opacity = wa.opacity;
                const vis = wa.visible && !mw.minimized;
                if (clone.visible !== vis)
                    clone.visible = vis;
            };
            syncGeom();
            entry.scene.add_child(clone);

            const sigIds = [
                wa.connect('notify::x', syncGeom),
                wa.connect('notify::y', syncGeom),
                wa.connect('notify::width', syncGeom),
                wa.connect('notify::height', syncGeom),
                wa.connect('notify::opacity', syncGeom),
                wa.connect('notify::visible', syncGeom),
                wa.connect('destroy', rebuild),
            ];
            entry.windowCloneItems.push({ wa, clone, sigIds });
        }
    }

    _updateMenu(entry) {
        const { actor } = entry;
        if (!actor)
            return;

        if (!this._prefs.blurStartMenu || !actor.visible) {
            if (entry.viewport && entry.viewport.visible)
                entry.viewport.hide();
            if (entry.shadow && entry.shadow.visible)
                entry.shadow.hide();
            if (entry.windowClonesActive) {
                this._clearMenuWindowClones(entry);
                entry.windowClonesActive = false;
            }
            return;
        }

        if (!entry.viewport)
            this._ensureMenuBackdrop(entry);

        const { viewport, shadow } = entry;
        if (actor.opacity === 0 || actor.scale_x === 0 || actor.scale_y === 0) {
            if (viewport.visible)
                viewport.hide();
            if (shadow.visible)
                shadow.hide();
            return;
        }

        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        if (aw <= 0 || ah <= 0) {
            if (viewport.visible)
                viewport.hide();
            if (shadow.visible)
                shadow.hide();
            return;
        }

        const mon = this._getMonitorForRect(ax, ay, aw, ah);
        if (!entry.windowClonesActive) {
            entry.windowClonesActive = true;
            this._syncMenuWindowClones(entry, mon, ax, ay, aw, ah);
        }

        this._syncMenuStacking(entry);

        let cornerRadius = 8 * this._scaleFactor;
        const themeNode = actor.get_stage() ? actor.get_theme_node() : null;
        if (themeNode) {
            const themeRad = themeNode.get_border_radius(St.Corner.TOPLEFT);
            if (themeRad > 0)
                cornerRadius = themeRad;
        }

        const shown = this._updateFrostedViewport(entry, ax, ay, aw, ah, mon, this._getEffectConfig(MENU_PRESETS), {
            cornerRadius,
            cornersTop: true,
            cornersBottom: true,
            borderEdge: 4.0,
        });

        if (shown && aw > 2 && ah > 2) {
            const sx = Math.round(ax) + 1;
            const sy = Math.round(ay) + 1;
            const sw = Math.max(0, Math.round(aw) - 2);
            const sh = Math.max(0, Math.round(ah) - 2);
            if (shadow.x !== sx || shadow.y !== sy)
                shadow.set_position(sx, sy);
            if (shadow.width !== sw || shadow.height !== sh)
                shadow.set_size(sw, sh);
            if (shadow.opacity !== actor.opacity)
                shadow.opacity = actor.opacity;
            if (!shadow.visible)
                shadow.show();
        } else if (shadow.visible) {
            shadow.hide();
        }
    }

    _teardownMenu(actor) {
        const entry = this._menus.get(actor);
        if (!entry)
            return;
        this._menus.delete(actor);

        if (entry.stackIdleId) {
            Mainloop.source_remove(entry.stackIdleId);
            entry.stackIdleId = 0;
        }
        entry.menuSignals.disconnectAllSignals();
        if (entry.backdropSignals) {
            entry.backdropSignals.disconnectAllSignals();
            entry.backdropSignals = null;
        }
        this._clearMenuWindowClones(entry);

        try {
            this._setStyleClass(actor, 'win11-frosted-start-menu', false);
            this._setStyleClass(actor, 'win11-frosted-start-menu-light', false);
            actor.set_style(entry.originalStyle || null);
        } catch (_e) {
            // Actor may already be destroyed
        }

        if (entry.shadow) {
            if (entry.shadow.get_parent())
                entry.shadow.get_parent().remove_child(entry.shadow);
            entry.shadow.destroy();
            entry.shadow = null;
        }
        this._destroySceneBackdrop(entry);
    }

    destroy() {
        this._signals.disconnectAllSignals();
        this._maxSignals.disconnectAllSignals();
        if (this._menuScanIdleId) {
            Mainloop.source_remove(this._menuScanIdleId);
            this._menuScanIdleId = 0;
        }

        for (const panel of Array.from(this._panels.keys())) {
            this._teardownPanel(panel);
        }
        for (const actor of Array.from(this._menus.keys())) {
            this._teardownMenu(actor);
        }

        Panel.Panel.prototype.enable = this._origPanelEnable;
        Panel.Panel.prototype.disable = this._origPanelDisable;

        this._settings.finalize();
    }
}

let _extensionMeta = null;
let _manager = null;

function init(extensionMeta) {
    _extensionMeta = extensionMeta;
    Effects.setExtensionPath(extensionMeta.path);
}

function enable() {
    if (_manager)
        return;
    _manager = new Win11FrostedTaskbarManager(_extensionMeta.uuid);
}

function disable() {
    if (_manager) {
        _manager.destroy();
        _manager = null;
    }
}
