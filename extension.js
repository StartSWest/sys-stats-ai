import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GNOME Shell imports extension.js once per login session and caches it, so the
// real code lives in the other modules and is imported again with a fresh URL on
// every enable. Turning the extension off and on (gnome-extensions disable/enable)
// then picks up code changes without logging out.
export default class LaptopMonitorExtension extends Extension {
    async enable() {
        const version = Date.now();
        const load = name => import(`${this.dir.get_child(name).get_uri()}?v=${version}`);
        const [{Stats}, {ClaudeUsage}, {LaptopMonitor}] = await Promise.all(
            ['stats.js', 'claude.js', 'widget.js'].map(load));
        this._monitor = new LaptopMonitor(this, {Stats, ClaudeUsage});
    }

    disable() {
        this._monitor?.destroy();
        this._monitor = null;
    }
}
