import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// One ranked, reorderable list of devices backed by a single GSettings string
// (JSON array, index 0 = highest priority).
class RankSection {
    constructor(settings, settingKey, title, description) {
        this._settings = settings;
        this._settingKey = settingKey;

        this.group = new Adw.PreferencesGroup({title, description});

        this._listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        this.group.add(this._listBox);

        this._rebuild();

        // Reflect changes made by the running extension (new devices appearing)
        // while the preferences window is open.
        this._changedId = this._settings.connect(
            `changed::${this._settingKey}`, () => this._rebuild());
        this._listBox.connect('destroy', () => {
            if (this._changedId) {
                this._settings.disconnect(this._changedId);
                this._changedId = 0;
            }
        });
    }

    _load() {
        try {
            return JSON.parse(this._settings.get_string(this._settingKey));
        } catch {
            return [];
        }
    }

    _save(list) {
        this._settings.set_string(this._settingKey, JSON.stringify(list));
    }

    _rebuild() {
        let child;
        while ((child = this._listBox.get_first_child()))
            this._listBox.remove(child);

        const devices = this._load();

        if (devices.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'No devices detected yet',
                subtitle: 'Connect or switch an audio device to add it here.',
            });
            empty.add_css_class('dim-label');
            this._listBox.append(empty);
            return;
        }

        devices.forEach((device, index) => {
            this._listBox.append(this._makeRow(device, index, devices.length));
        });
    }

    _makeRow(device, index, total) {
        const row = new Adw.ActionRow({
            title: device.label || device.key,
            subtitle: `Rank ${index + 1}`,
        });
        row.deviceKey = device.key;
        if (device.hidden)
            row.subtitle = `Rank ${index + 1} · Hidden from GNOME Shell`;

        // Drag handle — also the drag source, so the trash button still clicks.
        const handle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            css_classes: ['dim-label'],
            tooltip_text: 'Drag to reorder',
        });
        row.add_prefix(handle);

        const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        dragSource.connect('prepare', (_src, x, y) => {
            this._dragHotspot = [x, y];
            const value = new GObject.Value();
            value.init(Adw.ActionRow.$gtype);
            value.set_object(row);
            return Gdk.ContentProvider.new_for_value(value);
        });
        dragSource.connect('drag-begin', (src) => {
            const paintable = new Gtk.WidgetPaintable({widget: row});
            const [hx, hy] = this._dragHotspot ?? [0, 0];
            src.set_icon(paintable, hx, hy);
            row.add_css_class('drag-source');
        });
        dragSource.connect('drag-end', () => row.remove_css_class('drag-source'));
        handle.add_controller(dragSource);

        // The whole row accepts drops.
        const dropTarget = Gtk.DropTarget.new(Adw.ActionRow.$gtype, Gdk.DragAction.MOVE);
        dropTarget.connect('drop', (_t, source) => {
            this._reorder(source?.deviceKey, row.deviceKey);
            return true;
        });
        row.add_controller(dropTarget);

        // Up / down buttons as a keyboard- and touch-friendly alternative.
        const up = new Gtk.Button({
            icon_name: 'go-up-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: index > 0,
            tooltip_text: 'Move up',
        });
        up.connect('clicked', () => this._move(index, index - 1));

        const down = new Gtk.Button({
            icon_name: 'go-down-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: index < total - 1,
            tooltip_text: 'Move down',
        });
        down.connect('clicked', () => this._move(index, index + 1));

        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Forget this device',
        });
        remove.connect('clicked', () => this._forget(device.key));

        const visible = new Gtk.Switch({
            active: !device.hidden,
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Show in the GNOME Shell sound menu',
        });
        visible.connect('notify::active', () =>
            this._setHidden(device.key, !visible.active));

        row.add_suffix(visible);
        row.add_suffix(up);
        row.add_suffix(down);
        row.add_suffix(remove);

        return row;
    }

    _move(from, to) {
        const list = this._load();
        if (from < 0 || to < 0 || from >= list.length || to >= list.length)
            return;
        const [item] = list.splice(from, 1);
        list.splice(to, 0, item);
        this._save(list);
        this._rebuild();
    }

    _reorder(sourceKey, targetKey) {
        if (!sourceKey || sourceKey === targetKey)
            return;
        const list = this._load();
        const from = list.findIndex(d => d.key === sourceKey);
        const to = list.findIndex(d => d.key === targetKey);
        if (from < 0 || to < 0)
            return;
        this._move(from, to);
    }

    _setHidden(key, hidden) {
        const list = this._load();
        const entry = list.find(d => d.key === key);
        if (!entry || !!entry.hidden === hidden)
            return;
        if (hidden)
            entry.hidden = true;
        else
            delete entry.hidden;
        this._save(list);
    }

    _forget(key) {
        const list = this._load().filter(d => d.key !== key);
        this._save(list);
        this._rebuild();
    }
}

// A row showing a keyboard shortcut stored in a GSettings `as` key. Clicking
// it opens a small capture window; Backspace clears it, Escape cancels.
function makeShortcutRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});

    const label = new Gtk.ShortcutLabel({
        disabled_text: 'Disabled',
        valign: Gtk.Align.CENTER,
    });
    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    const changedId = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(changedId));

    const clear = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: 'Remove shortcut',
    });
    clear.connect('clicked', () => settings.set_strv(key, []));

    row.add_suffix(label);
    row.add_suffix(clear);
    row.connect('activated', () => captureShortcut(row, settings, key, title));
    return row;
}

function captureShortcut(parentWidget, settings, key, title) {
    const window = new Adw.Window({
        modal: true,
        transient_for: parentWidget.get_root(),
        default_width: 420,
        resizable: false,
        title,
    });

    const page = new Adw.StatusPage({
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        title: 'Press a shortcut',
        description: 'Escape to cancel, Backspace to remove the shortcut.',
    });
    const toolbar = new Adw.ToolbarView({content: page});
    toolbar.add_top_bar(new Adw.HeaderBar({show_title: false}));
    window.set_content(toolbar);

    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
        let mask = state & Gtk.accelerator_get_default_mod_mask();
        mask &= ~Gdk.ModifierType.LOCK_MASK;

        if (mask === 0 && keyval === Gdk.KEY_Escape) {
            window.close();
            return Gdk.EVENT_STOP;
        }
        if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(key, []);
            window.close();
            return Gdk.EVENT_STOP;
        }

        // Ignore lone modifier presses and bare keys that would steal normal
        // typing; function and media keys are fine without a modifier.
        const isSpecialKey = (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) ||
            keyval >= 0x1008FF00;
        if (!Gtk.accelerator_valid(keyval, mask) || (mask === 0 && !isSpecialKey))
            return Gdk.EVENT_STOP;

        settings.set_strv(key, [Gtk.accelerator_name(keyval, mask)]);
        window.close();
        return Gdk.EVENT_STOP;
    });
    window.add_controller(controller);
    window.present();
}

export default class AudioDeviceRankerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // A General toggle on each tab, kept in sync through the shared
        // GSettings key, so auto-switch is reachable wherever the user is.
        const makeGeneralGroup = () => {
            const group = new Adw.PreferencesGroup({title: 'General'});
            const autoSwitch = new Adw.SwitchRow({
                title: 'Auto-switch on connect',
                subtitle: 'Switch to a higher-ranked device when it connects.',
            });
            settings.bind('auto-switch', autoSwitch, 'active',
                Gio.SettingsBindFlags.DEFAULT);
            group.add(autoSwitch);
            return group;
        };

        const makeShortcutGroup = (key, title, subtitle) => {
            const group = new Adw.PreferencesGroup({title: 'Shortcut'});
            group.add(makeShortcutRow(settings, key, title, subtitle));
            return group;
        };

        // Output tab.
        const outputPage = new Adw.PreferencesPage({
            title: 'Output',
            icon_name: 'audio-speakers-symbolic',
        });
        outputPage.add(makeGeneralGroup());
        outputPage.add(makeShortcutGroup('cycle-output-shortcut',
            'Cycle output device',
            'Switch to the next connected, visible output in rank order.'));
        const output = new RankSection(settings, 'output-devices',
            'Output Devices',
            'Drag, or use the arrows, to rank playback devices. The top device wins. Switch a device off to hide it from the GNOME Shell sound menu.');
        outputPage.add(output.group);
        window.add(outputPage);

        // Input tab.
        const inputPage = new Adw.PreferencesPage({
            title: 'Input',
            icon_name: 'audio-input-microphone-symbolic',
        });
        inputPage.add(makeGeneralGroup());
        inputPage.add(makeShortcutGroup('cycle-input-shortcut',
            'Cycle input device',
            'Switch to the next connected, visible input in rank order.'));
        const input = new RankSection(settings, 'input-devices',
            'Input Devices',
            'Drag, or use the arrows, to rank recording devices. The top device wins. Switch a device off to hide it from the GNOME Shell sound menu.');
        inputPage.add(input.group);
        window.add(inputPage);

        window.set_default_size(620, 720);
    }
}
