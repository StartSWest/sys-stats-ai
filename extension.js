import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClaudeUsage} from './claude.js';
import {Stats} from './stats.js';
import {LaptopMonitor} from './widget.js';

export default class SysStatsExtension extends Extension {
    enable() {
        this._monitor = new LaptopMonitor(this, {Stats, ClaudeUsage});
    }

    disable() {
        this._monitor?.destroy();
        this._monitor = null;
    }
}
