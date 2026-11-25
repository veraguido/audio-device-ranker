import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// A device's "key" must be stable across disconnect/reconnect (and reboots),
// so we derive it from the description and origin reported by PulseAudio /
// PipeWire rather than from the volatile numeric id assigned per session.
function deviceKey(dev) {
    const desc = dev.get_description() ?? '';
    const origin = dev.get_origin() ?? '';
    return `${desc}\u0000${origin}`;
}

function deviceLabel(dev) {
    const desc = dev.get_description() ?? '';
    const origin = dev.get_origin() ?? '';
    return origin ? `${desc} — ${origin}` : desc;
}

const KINDS = ['output', 'input'];

const SHORTCUT_KEYS = {
    output: 'cycle-output-shortcut',
    input: 'cycle-input-shortcut',
};

const OSD_ICONS = {
    output: 'audio-speakers-symbolic',
    input: 'audio-input-microphone-symbolic',
};

export default class AudioDeviceRankerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._signalIds = [];
        this._settingsIds = [];
        this._timeouts = new Set();
        this._injections = new InjectionManager();

        // Currently-connected devices, per kind, mapping the volatile per-session
        // device id to its stable key. Used to find the best still-present device
        // when one disconnects.
        this._present = {output: new Map(), input: new Map()};

        this._control = new Gvc.MixerControl({name: 'Audio Device Ranker'});

        this._signalIds.push(this._control.connect('output-added',
            (_c, id) => this._onDeviceAdded('output', id)));
        this._signalIds.push(this._control.connect('input-added',
            (_c, id) => this._onDeviceAdded('input', id)));
        this._signalIds.push(this._control.connect('output-removed',
            (_c, id) => this._onDeviceRemoved('output', id)));
        this._signalIds.push(this._control.connect('input-removed',
            (_c, id) => this._onDeviceRemoved('input', id)));

        this._control.open();

        for (const kind of KINDS) {
            Main.wm.addKeybinding(SHORTCUT_KEYS[kind], this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW |
                Shell.ActionMode.POPUP,
                () => this._cycle(kind));
        }

        this._hookQuickSettings();

        for (const kind of KINDS) {
            this._settingsIds.push(this._settings.connect(
                `changed::${kind}-devices`, () => this._onListChanged(kind)));
        }
    }

    disable() {
        for (const kind of KINDS)
            Main.wm.removeKeybinding(SHORTCUT_KEYS[kind]);

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];

        // Restore GNOME Shell's own device menus before dropping our state, so
        // hidden devices reappear when the extension is disabled.
        this._injections.clear();
        this._injections = null;
        for (const kind of KINDS)
            this._applyVisibility(kind, true);
        this._sliders = null;

        for (const source of this._timeouts)
            GLib.Source.remove(source);
        this._timeouts.clear();

        if (this._control) {
            for (const id of this._signalIds)
                this._control.disconnect(id);
            this._control.close();
            this._control = null;
        }
        this._signalIds = [];
        this._present = null;
        this._settings = null;
    }

    _list(kind) {
        const setting = kind === 'output' ? 'output-devices' : 'input-devices';
        try {
            return JSON.parse(this._settings.get_string(setting));
        } catch {
            return [];
        }
    }

    _saveList(kind, list) {
        const setting = kind === 'output' ? 'output-devices' : 'input-devices';
        this._settings.set_string(setting, JSON.stringify(list));
    }

    _isHidden(kind, key, list = this._list(kind)) {
        return list.some(d => d.key === key && d.hidden);
    }

    _lookup(kind, id) {
        return kind === 'output'
            ? this._control.lookup_output_id(id)
            : this._control.lookup_input_id(id);
    }

    _onDeviceAdded(kind, id) {
        const dev = this._lookup(kind, id);
        if (!dev)
            return;

        this._present[kind].set(id, deviceKey(dev));
        this._register(kind, dev);

        if (this._settings.get_boolean('auto-switch'))
            this._scheduleSwitch(kind, id);
    }

    _onDeviceRemoved(kind, id) {
        this._present[kind].delete(id);

        // If the device that just went away was the active one, the system
        // falls back to an arbitrary default. Re-evaluate so we land on the
        // highest-ranked device that is still connected.
        if (this._settings.get_boolean('auto-switch'))
            this._scheduleReevaluate(kind);
    }

    // Remember a freshly seen device so it shows up (and can be ranked) in the
    // preferences, even after it later disconnects.
    _register(kind, dev) {
        const key = deviceKey(dev);
        const label = deviceLabel(dev);
        const list = this._list(kind);
        const existing = list.find(d => d.key === key);

        if (existing) {
            if (existing.label !== label) {
                existing.label = label;
                this._saveList(kind, list);
            }
            return;
        }

        // New devices start at the bottom of the ranking.
        list.push({key, label});
        this._saveList(kind, list);
    }

    // Switching right when the device appears can race the port becoming
    // usable (notably for Bluetooth), so we defer briefly and re-look-up the
    // device to make sure it is still present.
    _scheduleSwitch(kind, id) {
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._timeouts.delete(source);
            const dev = this._lookup(kind, id);
            if (dev)
                this._maybeSwitch(kind, dev);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(source);
    }

    // After a disconnect, the new system default may not have settled yet, so
    // defer briefly before picking the best still-present device.
    _scheduleReevaluate(kind) {
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._timeouts.delete(source);
            const dev = this._bestPresentDevice(kind);
            if (dev)
                this._maybeSwitch(kind, dev);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(source);
    }

    // The highest-ranked device (lowest index) that is currently connected.
    _bestPresentDevice(kind) {
        const present = this._present[kind];
        for (const entry of this._list(kind)) {
            if (entry.hidden)
                continue;
            for (const [id, key] of present) {
                if (key !== entry.key)
                    continue;
                const dev = this._lookup(kind, id);
                if (dev)
                    return dev;
            }
        }
        return null;
    }

    _maybeSwitch(kind, dev) {
        const list = this._list(kind);
        const newIndex = list.findIndex(d => d.key === deviceKey(dev));
        if (newIndex < 0)
            return; // Unranked device: never auto-switch.
        if (list[newIndex].hidden)
            return; // Hidden device: never auto-switch.

        // Find the rank of the currently active device.
        const stream = kind === 'output'
            ? this._control.get_default_sink()
            : this._control.get_default_source();

        let activeIndex = -1;
        if (stream) {
            const activeDev = this._control.lookup_device_from_stream(stream);
            if (activeDev)
                activeIndex = list.findIndex(d => d.key === deviceKey(activeDev));
        }
        // A hidden active device counts as unranked, so anything visible wins.
        if (activeIndex !== -1 && list[activeIndex].hidden)
            activeIndex = -1;

        // Switch only if the new device outranks the active one (lower index),
        // or the active device is not ranked at all.
        if (activeIndex !== -1 && newIndex >= activeIndex)
            return;

        if (kind === 'output') {
            this._control.change_output(dev);
            // Only output switches are announced; input stays silent.
            Main.notify('Audio Device Ranker',
                `Switched output to ${deviceLabel(dev)}`);
        } else {
            this._control.change_input(dev);
        }
    }

    _activeDevice(kind) {
        const stream = kind === 'output'
            ? this._control.get_default_sink()
            : this._control.get_default_source();
        return stream ? this._control.lookup_device_from_stream(stream) : null;
    }

    // Keyboard shortcut: move to the next connected, visible device in rank
    // order, wrapping around at the end.
    _cycle(kind) {
        const list = this._list(kind);
        const candidates = [];
        for (const entry of list) {
            if (entry.hidden)
                continue;
            for (const [id, key] of this._present[kind]) {
                if (key !== entry.key)
                    continue;
                const dev = this._lookup(kind, id);
                if (dev)
                    candidates.push(dev);
            }
        }

        if (candidates.length === 0)
            return;

        const active = this._activeDevice(kind);
        const activeKey = active ? deviceKey(active) : null;
        const current = candidates.findIndex(d => deviceKey(d) === activeKey);
        const next = candidates[(current + 1) % candidates.length];

        if (kind === 'output')
            this._control.change_output(next);
        else
            this._control.change_input(next);

        Main.osdWindowManager.showAll(
            new Gio.ThemedIcon({name: OSD_ICONS[kind]}), deviceLabel(next));
    }

    _onListChanged(kind) {
        this._applyVisibility(kind);

        // If the active device was just hidden, move off it.
        const active = this._activeDevice(kind);
        if (active && this._isHidden(kind, deviceKey(active))) {
            const best = this._bestPresentDevice(kind);
            if (best)
                this._maybeSwitch(kind, best);
        }
    }

    // GNOME Shell's Quick Settings output/input sliders each keep a map of
    // device id -> menu item. We hide the items of hidden devices and keep the
    // menu's "is there anything to choose" state in line with what is shown.
    _hookQuickSettings() {
        const qs = Main.panel.statusArea.quickSettings;
        this._sliders = {
            output: qs?._volumeOutput?._output ?? null,
            input: qs?._volumeInput?._input ?? null,
        };

        for (const kind of KINDS) {
            const slider = this._sliders[kind];
            if (!slider?._deviceItems) {
                console.warn(`[${this.uuid}] Quick Settings ${kind} menu not found; hiding devices there is unavailable`);
                this._sliders[kind] = null;
                continue;
            }

            const ext = this;
            this._injections.overrideMethod(slider, '_addDevice', original => function (...args) {
                original.apply(this, args);
                ext._applyVisibility(kind);
            });
            this._injections.overrideMethod(slider, '_sync', original => function (...args) {
                original.apply(this, args);
                ext._syncMenuEnabled(kind);
            });

            this._applyVisibility(kind);
        }
    }

    _applyVisibility(kind, showAll = false) {
        const slider = this._sliders?.[kind];
        if (!slider)
            return;

        // The slider's ids belong to GNOME Shell's own mixer control, not ours,
        // so look devices up through it.
        const control = slider._control;
        const list = showAll ? [] : this._list(kind);
        for (const [id, item] of slider._deviceItems) {
            const dev = kind === 'output'
                ? control.lookup_output_id(id)
                : control.lookup_input_id(id);
            item.visible = !(dev && this._isHidden(kind, deviceKey(dev), list));
        }

        if (showAll)
            slider._sync();
        else
            this._syncMenuEnabled(kind);
    }

    _syncMenuEnabled(kind) {
        const slider = this._sliders?.[kind];
        if (!slider)
            return;
        let visible = 0;
        for (const item of slider._deviceItems.values()) {
            if (item.visible)
                visible++;
        }
        slider.menuEnabled = visible > 1;
    }
}
