// Top-bar indicator and popup for Laptop Monitor: icons in the panel, gauges,
// graphs and detail tiles in the menu. extension.js imports this file again with
// a fresh URL on every enable, so nothing here may call GObject.registerClass
// (a GType name can only be registered once per session).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 2;
const HISTORY_LENGTH = 90; // 3 minutes at REFRESH_SECONDS
const CLAUDE_REFRESH_SECONDS = 120; // also the minimum gap between usage requests
const GB = 1024 ** 3;

const PANEL_ITEMS = [
    ['cpu', 'CPU'],
    ['gpu', 'GPU'],
    ['memory', 'Memory'],
    ['temperature', 'Temperature'],
    ['battery', 'Battery'],
    ['claude', 'Claude usage'],
];

const COLORS = {
    cpu: [0.38, 0.63, 0.92],
    gpu: [0.30, 0.82, 0.80],
    memory: [0.75, 0.47, 0.86],
    temperature: [1.0, 0.64, 0.28],
    battery: [0.34, 0.85, 0.54],
    claude: [0.85, 0.47, 0.34],
    warn: [0.97, 0.78, 0.29],
    crit: [1.0, 0.42, 0.37],
};

const ARC_START = 0.75 * Math.PI;
const ARC_SWEEP = 1.5 * Math.PI;

const clamp = x => Math.min(1, Math.max(0, x));
const fmtGB = bytes => (bytes / GB).toFixed(1);

function level(value, warn, crit) {
    if (value >= crit)
        return 'crit';
    return value >= warn ? 'warn' : 'ok';
}

const levelColor = (color, lvl) => COLORS[lvl === 'ok' ? color : lvl];

function fmtDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0)
        return '—';
    const d = Math.floor(minutes / 1440);
    const h = Math.floor(minutes % 1440 / 60);
    const m = Math.round(minutes % 60);
    if (d)
        return `${d} d ${h} h`;
    return h ? `${h} h ${m} min` : `${m} min`;
}

function fmtReset(ms) {
    if (!ms)
        return '';
    const minutes = (ms - Date.now()) / 60000;
    if (minutes <= 0)
        return 'Resetting now';
    const at = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const when = at.format(minutes < 1440 ? '%H:%M' : '%a %H:%M');
    return `Resets in ${fmtDuration(minutes)} · ${when}`;
}

function batteryIconName(bat) {
    const lvl = Math.min(100, Math.max(0, Math.round(bat.capacity / 10) * 10));
    if (lvl === 100 && bat.acOnline)
        return 'battery-level-100-charged-symbolic';
    if (bat.status === 'Charging')
        return `battery-level-${lvl}-charging-symbolic`;
    if (bat.acOnline)
        return `battery-level-${lvl}-plugged-in-symbolic`;
    return `battery-level-${lvl}-symbolic`;
}

function foreground(actor) {
    const c = actor.get_theme_node().get_foreground_color();
    return [c.red / 255, c.green / 255, c.blue / 255];
}

function paint(area, draw) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    try {
        draw(cr, w, h, foreground(area));
    } finally {
        cr.$dispose();
    }
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// Highest non-null value in a history list, or null.
const peakOf = list => list.reduce((max, v) => (v === null ? max : Math.max(max ?? v, v)), null);

function pushHistory(list, value) {
    list.push(value);
    if (list.length > HISTORY_LENGTH)
        list.shift();
}

function drawSpark(area, data, n = 16) {
    paint(area, (cr, w, h, fg) => {
        const recent = data.slice(-n);
        const bw = w / n;
        cr.setSourceRGBA(...fg, 0.3);
        cr.rectangle(0, h - 1, w, 1);
        cr.fill();
        recent.forEach((v, i) => {
            const bh = Math.max(1, h * clamp((v ?? 0) / 100));
            cr.setSourceRGBA(...levelColor('cpu', level(v ?? 0, 70, 90)), 1);
            cr.rectangle((n - recent.length + i) * bw + 0.3, h - bh, bw - 0.6, bh);
            cr.fill();
        });
    });
}

const label = (text, style_class, props = {}) => new St.Label({text, style_class, ...props});

function vbox(style_class, props = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class, ...props});
}

const mix = (a, b, f) => a.map((v, i) => v + (b[i] - v) * clamp(f));

// Colour at fraction t of a scale: the base colour (a little brighter as it
// rises), blending into amber just before `warn` and on to red at `crit`.
function heatColor(base, t, warn = 0.7, crit = 0.9) {
    const color = mix(base, [1, 1, 1], 0.18 * t);
    if (t < warn - 0.12)
        return color;
    if (t < warn)
        return mix(color, COLORS.warn, (t - (warn - 0.12)) / 0.12);
    return mix(COLORS.warn, COLORS.crit, (t - warn) / (crit - warn));
}

// Circular 270° dial: tick marks, a track tinted where the warning and critical
// ranges start, a value arc that shades towards amber/red as it climbs, a knob at
// its end and a mark at the recent peak. The value and title sit in the middle.
class Gauge {
    // warn/crit are in value units; with `inverted`, low values are the bad ones.
    constructor(title, color, {min = 0, max = 100, warn, crit, inverted = false} = {}) {
        this._base = COLORS[color];
        this._min = min;
        this._max = max;
        this._warn = this._fraction(warn);
        this._crit = this._fraction(crit);
        this._inverted = inverted;
        this._target = 0;
        this._shown = 0;
        this._peak = null;

        this.actor = vbox('lm-gauge', {x_expand: true});
        const dial = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'lm-dial',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._draw(a));
        this._area.connect('destroy', () => this._timeline?.stop());
        dial.add_child(this._area);
        this._value = label('…', 'lm-gauge-value', {
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        dial.add_child(this._value);
        dial.add_child(label(title, 'lm-gauge-title', {
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        }));
        this.actor.add_child(dial);
        this._detail = label('', 'lm-gauge-detail', {x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._detail);
    }

    _fraction(value) {
        return value === null || value === undefined
            ? null
            : clamp((value - this._min) / (this._max - this._min));
    }

    set(value, text, detail, lvl, peak = null) {
        // Big number, small unit.
        const [, number, unit] = text.match(/^(.*?)([%°]?)$/);
        this._value.clutter_text.set_markup(unit
            ? `${GLib.markup_escape_text(number, -1)}<span size="65%" alpha="70%">${unit}</span>`
            : GLib.markup_escape_text(number, -1));
        for (const l of ['warn', 'crit'])
            this._value[lvl === l ? 'add_style_class_name' : 'remove_style_class_name'](`lm-${l}`);
        this._detail.text = detail;
        this._peak = this._fraction(peak);

        const target = this._fraction(value) ?? 0;
        if (target === this._target)
            return;
        this._target = target;
        this._animate();
    }

    // Glide from the drawn value to the new one; jump when the menu is closed.
    _animate() {
        this._timeline?.stop();
        if (!this._area.mapped) {
            this._shown = this._target;
            this._area.queue_repaint();
            return;
        }
        const from = this._shown;
        const to = this._target;
        this._timeline = new Clutter.Timeline({
            actor: this._area,
            duration: 600,
            progress_mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._timeline.connect('new-frame', t => {
            this._shown = from + (to - from) * t.get_progress();
            this._area.queue_repaint();
        });
        this._timeline.connect('completed', () => {
            this._shown = to;
            this._area.queue_repaint();
        });
        this._timeline.start();
    }

    // Colour of the arc at fraction t of the scale.
    _colorAt(t) {
        const base = mix(this._base, [1, 1, 1], 0.18 * t);
        const w = this._warn;
        const c = this._crit;
        if (w === null)
            return base;
        if (this._inverted) {
            if (t <= c)
                return COLORS.crit;
            if (t <= w)
                return mix(COLORS.crit, COLORS.warn, (t - c) / (w - c));
            return mix(COLORS.warn, base, (t - w) / 0.1);
        }
        return heatColor(this._base, t, w, c);
    }

    _draw(area) {
        paint(area, (cr, w, h, fg) => {
            const r = Math.min(w, h) / 2 - 13;
            const cx = w / 2;
            const cy = h / 2 + 0.12 * r;
            const angle = t => ARC_START + ARC_SWEEP * t;
            const at = (t, radius) => [cx + radius * Math.cos(angle(t)), cy + radius * Math.sin(angle(t))];

            // Ticks every 10%, longer at 0, 50 and 100%.
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (let i = 0; i <= 10; i++) {
                const major = i % 5 === 0;
                cr.moveTo(...at(i / 10, r + 8));
                cr.lineTo(...at(i / 10, r + (major ? 12 : 10)));
                cr.setLineWidth(major ? 1.6 : 1);
                cr.setSourceRGBA(...fg, major ? 0.4 : 0.22);
                cr.stroke();
            }

            // Track, tinted where the warning and critical ranges start.
            cr.setLineWidth(8);
            cr.setSourceRGBA(...fg, 0.1);
            cr.arc(cx, cy, r, angle(0), angle(1));
            cr.stroke();
            if (this._warn !== null) {
                const zones = this._inverted
                    ? [[0, this._crit, 'crit'], [this._crit, this._warn, 'warn']]
                    : [[this._warn, this._crit, 'warn'], [this._crit, 1, 'crit']];
                cr.setLineCap(Cairo.LineCap.BUTT);
                for (const [from, to, zone] of zones) {
                    cr.setSourceRGBA(...COLORS[zone], 0.22);
                    cr.arc(cx, cy, r, angle(from), angle(to));
                    cr.stroke();
                }
            }

            const t = this._shown;
            if (t > 0.004) {
                // Short segments so the colour can follow the scale; a soft wide
                // pass first for the glow, then the solid arc.
                const steps = Math.max(2, Math.ceil(t * 120));
                cr.setLineCap(Cairo.LineCap.BUTT);
                for (const [width, alpha, overlap] of [[15, 0.13, 0], [8, 1, 0.012]]) {
                    cr.setLineWidth(width);
                    for (let i = 0; i < steps; i++) {
                        const a = t * i / steps;
                        const b = t * (i + 1) / steps;
                        cr.setSourceRGBA(...this._colorAt((a + b) / 2), alpha);
                        cr.arc(cx, cy, r, angle(a), angle(b) + (i < steps - 1 ? overlap : 0));
                        cr.stroke();
                    }
                }
                // Rounded start.
                cr.setSourceRGBA(...this._colorAt(0), 1);
                cr.arc(...at(0, r), 4, 0, 2 * Math.PI);
                cr.fill();
            }

            // Peak of the last few minutes, when it is above the current value.
            if (this._peak !== null && this._peak > t + 0.015) {
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineWidth(2);
                cr.setSourceRGBA(...fg, 0.75);
                cr.moveTo(...at(this._peak, r - 6));
                cr.lineTo(...at(this._peak, r + 6));
                cr.stroke();
            }

            // Knob at the end of the arc, with a halo.
            const [kx, ky] = at(t, r);
            const knob = this._colorAt(t);
            const halo = new Cairo.RadialGradient(kx, ky, 0, kx, ky, 12);
            halo.addColorStopRGBA(0, ...knob, 0.55);
            halo.addColorStopRGBA(1, ...knob, 0);
            cr.setSource(halo);
            cr.arc(kx, ky, 12, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(...knob, 1);
            cr.arc(kx, ky, 6, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.95);
            cr.arc(kx, ky, 2.4, 0, 2 * Math.PI);
            cr.fill();
        });
    }
}

// Catmull-Rom curve through the points, with control points kept inside
// [top, bottom] so the curve never overshoots the plot.
function smoothPath(cr, points, top, bottom) {
    const fit = y => Math.min(bottom, Math.max(top, y));
    cr.moveTo(...points[0]);
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        cr.curveTo(
            p1[0] + (p2[0] - p0[0]) / 6, fit(p1[1] + (p2[1] - p0[1]) / 6),
            p2[0] - (p3[0] - p1[0]) / 6, fit(p2[1] - (p3[1] - p1[1]) / 6),
            ...p2);
    }
}

function showText(cr, text, x, y, align = 'left') {
    const {width, xBearing} = cr.textExtents(text);
    const shift = {left: 0, center: width / 2, right: width}[align];
    cr.moveTo(x - xBearing - shift, y);
    cr.showText(text);
}

// Smoothed chart of the last HISTORY_LENGTH samples, newest on the right, with
// a 0/50/100% scale, a time axis and a dot on each line's latest value.
class HistoryChart {
    // series: [{data, color, fill}] where fill is the gradient's top opacity.
    constructor(series) {
        this._series = series;
        this.actor = new St.DrawingArea({style_class: 'lm-chart', x_expand: true});
        this.actor.connect('repaint', a => this._draw(a));
    }

    _draw(area) {
        paint(area, (cr, w, h, fg) => {
            const left = 34, right = w - 10, top = 10, bottom = h - 20;
            const step = (right - left) / (HISTORY_LENGTH - 1);
            const yOf = v => bottom - (bottom - top) * clamp((v ?? 0) / 100);

            roundedRect(cr, 0, 0, w, h, 12);
            cr.setSourceRGBA(...fg, 0.045);
            cr.fill();

            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
            cr.setFontSize(9);
            cr.setLineWidth(1);
            for (const v of [0, 50, 100]) {
                const y = Math.round(yOf(v)) + 0.5;
                cr.setDash(v ? [2, 4] : [], 0);
                cr.setSourceRGBA(...fg, v ? 0.12 : 0.2);
                cr.moveTo(left, y);
                cr.lineTo(right, y);
                cr.stroke();
                cr.setSourceRGBA(...fg, 0.45);
                showText(cr, `${v}%`, left - 7, y + 3, 'right');
            }
            cr.setDash([], 0);
            [['3 min', 0, 'left'], ['2 min', 1 / 3, 'center'], ['1 min', 2 / 3, 'center'], ['now', 1, 'right']]
                .forEach(([text, f, align]) => showText(cr, text, left + (right - left) * f, h - 6, align));

            const lines = this._series
                .filter(s => s.data.length >= 2)
                .map(s => ({...s, points: s.data.map((v, i) => [left + (HISTORY_LENGTH - s.data.length + i) * step, yOf(v)])}));

            for (const {points, color, fill} of lines) {
                const [red, green, blue] = COLORS[color];
                smoothPath(cr, points, top, bottom);
                cr.lineTo(points.at(-1)[0], bottom);
                cr.lineTo(points[0][0], bottom);
                cr.closePath();
                const gradient = new Cairo.LinearGradient(0, top, 0, bottom);
                gradient.addColorStopRGBA(0, red, green, blue, fill);
                gradient.addColorStopRGBA(1, red, green, blue, 0);
                cr.setSource(gradient);
                cr.fill();
            }
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (const {points, color} of lines) {
                smoothPath(cr, points, top, bottom);
                cr.setLineWidth(2);
                cr.setSourceRGBA(...COLORS[color], 1);
                cr.stroke();
            }
            for (const {points, color} of lines) {
                const [x, y] = points.at(-1);
                const halo = new Cairo.RadialGradient(x, y, 0, x, y, 9);
                halo.addColorStopRGBA(0, ...COLORS[color], 0.6);
                halo.addColorStopRGBA(1, ...COLORS[color], 0);
                cr.setSource(halo);
                cr.arc(x, y, 9, 0, 2 * Math.PI);
                cr.fill();
                cr.setSourceRGBA(...COLORS[color], 1);
                cr.arc(x, y, 3.4, 0, 2 * Math.PI);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.95);
                cr.arc(x, y, 1.4, 0, 2 * Math.PI);
                cr.fill();
            }
        });
    }
}

// One capsule per CPU thread filled with a heat gradient, thread numbers below
// and a dashed line at the average.
class CoreBars {
    constructor() {
        this.values = [];
        this.actor = new St.DrawingArea({style_class: 'lm-cores', x_expand: true});
        this.actor.connect('repaint', a => this._draw(a));
    }

    _draw(area) {
        paint(area, (cr, w, h, fg) => {
            const n = this.values.length;
            if (!n)
                return;
            const barH = h - 15;
            const gap = 5;
            const bw = (w - gap * (n - 1)) / n;
            const radius = Math.min(6, bw / 2);
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
            cr.setFontSize(8.5);

            this.values.forEach((v, i) => {
                const x = i * (bw + gap);
                roundedRect(cr, x, 0, bw, barH, radius);
                cr.setSourceRGBA(...fg, 0.07);
                cr.fill();

                const f = clamp((v ?? 0) / 100);
                const bh = barH * f;
                if (bh >= 2) {
                    const gradient = new Cairo.LinearGradient(0, barH, 0, barH - bh);
                    gradient.addColorStopRGBA(0, ...heatColor(COLORS.cpu, 0), 0.8);
                    gradient.addColorStopRGBA(1, ...heatColor(COLORS.cpu, f), 1);
                    roundedRect(cr, x, barH - bh, bw, bh, Math.min(radius, bh / 2));
                    cr.setSource(gradient);
                    cr.fill();
                }
                cr.setSourceRGBA(...fg, 0.45);
                showText(cr, String(i), x + bw / 2, h - 2, 'center');
            });

            const avg = this.values.reduce((a, v) => a + (v ?? 0), 0) / n;
            const y = Math.round(barH - barH * avg / 100) + 0.5;
            cr.setDash([3, 3], 0);
            cr.setLineWidth(1);
            cr.setSourceRGBA(...fg, 0.6);
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
            cr.setDash([], 0);
        });
    }
}

// Small ring for the summary shown on a collapsed Overview header.
class MiniRing {
    constructor(color) {
        this._color = color;
        this._fraction = 0;
        this._level = 'ok';
        this.actor = new St.DrawingArea({style_class: 'lm-mini-ring', y_align: Clutter.ActorAlign.CENTER});
        this.actor.connect('repaint', a => this._draw(a));
    }

    set(fraction, lvl) {
        this._fraction = clamp(fraction);
        this._level = lvl;
        this.actor.queue_repaint();
    }

    _draw(area) {
        paint(area, (cr, w, h, fg) => {
            const r = Math.min(w, h) / 2 - 2;
            cr.setLineWidth(3);
            cr.setSourceRGBA(...fg, 0.15);
            cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
            cr.stroke();
            if (this._fraction <= 0)
                return;
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setSourceRGBA(...levelColor(this._color, this._level), 1);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this._fraction);
            cr.stroke();
        });
    }
}

// Small horizontal bar for the summary shown on a collapsed Claude header.
class MiniBar {
    constructor(color) {
        this._color = color;
        this._fraction = 0;
        this._level = 'ok';
        this.actor = new St.DrawingArea({style_class: 'lm-mini-bar', y_align: Clutter.ActorAlign.CENTER});
        this.actor.connect('repaint', a => this._draw(a));
    }

    set(fraction, lvl) {
        this._fraction = clamp(fraction);
        this._level = lvl;
        this.actor.queue_repaint();
    }

    _draw(area) {
        paint(area, (cr, w, h, fg) => {
            roundedRect(cr, 0, 0, w, h, h / 2);
            cr.setSourceRGBA(...fg, 0.15);
            cr.fill();
            if (this._fraction <= 0)
                return;
            roundedRect(cr, 0, 0, Math.max(h, w * this._fraction), h, h / 2);
            cr.setSourceRGBA(...levelColor(this._color, this._level), 1);
            cr.fill();
        });
    }
}

// Title, percentage and a horizontal bar for one Claude plan limit.
class UsageBar {
    constructor(title) {
        this._fraction = 0;
        this._level = 'ok';
        this.actor = vbox('lm-usage', {x_expand: true});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(label(title, 'lm-usage-title', {x_expand: true}));
        this._percent = label('', 'lm-usage-percent');
        header.add_child(this._percent);
        this.actor.add_child(header);
        this._bar = new St.DrawingArea({style_class: 'lm-bar', x_expand: true});
        this._bar.connect('repaint', a => this._draw(a));
        this.actor.add_child(this._bar);
        this._reset = label('', 'lm-usage-reset');
        this.actor.add_child(this._reset);
    }

    set(percent, resetText) {
        this._fraction = clamp(percent / 100);
        this._level = level(percent, 75, 90);
        this._percent.text = `${Math.round(percent)}%`;
        this._reset.text = resetText;
        this._bar.queue_repaint();
    }

    _draw(area) {
        paint(area, (cr, w, h, fg) => {
            roundedRect(cr, 0, 0, w, h, h / 2);
            cr.setSourceRGBA(...fg, 0.12);
            cr.fill();
            if (this._fraction <= 0)
                return;
            const [red, green, blue] = levelColor('claude', this._level);
            const gradient = new Cairo.LinearGradient(0, 0, w, 0);
            gradient.addColorStopRGBA(0, red, green, blue, 0.7);
            gradient.addColorStopRGBA(1, red, green, blue, 1);
            roundedRect(cr, 0, 0, Math.max(h, w * this._fraction), h, h / 2);
            cr.setSource(gradient);
            cr.fill();
        });
    }
}

export class LaptopMonitor {
    constructor(extension, {Stats, ClaudeUsage}) {
        this._ext = extension;
        this._settings = extension.getSettings();
        this._stats = new Stats();
        this._claude = new ClaudeUsage();
        this._history = {cpu: [], gpu: [], memory: [], temperature: []};
        this._available = {cpu: true, gpu: true, memory: true, temperature: true, battery: !!this._stats.batteryPath, claude: true};

        this._button = new PanelMenu.Button(0.0, 'Laptop Monitor');
        this._buildPanel();
        this._buildMenu();
        Main.panel.addToStatusArea(extension.uuid, this._button, 0, 'right');

        this._button.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._onMenuOpened();
        });
        this._settingsId = this._settings.connect('changed::panel-items', () => this._syncPanelItems());
        this._groupsId = this._settings.connect('changed::collapsed-groups', () => this._syncGroups());

        this._update();
        this._syncPanelItems();
        this._refreshClaude();

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _icon(name) {
        return new St.Icon({gicon: this._gicon(name), style_class: 'system-status-icon lm-panel-icon'});
    }

    _gicon(name) {
        return Gio.FileIcon.new(this._ext.dir.resolve_relative_path(`icons/${name}-symbolic.svg`));
    }

    _buildPanel() {
        const box = new St.BoxLayout({style_class: 'lm-panel'});
        this._button.add_child(box);
        this._panel = {};

        this._spark = new St.DrawingArea({style_class: 'lm-spark', y_align: Clutter.ActorAlign.CENTER});
        this._spark.connect('repaint', a => drawSpark(a, this._history.cpu));
        this._batteryIcon = new St.Icon({
            icon_name: 'battery-missing-symbolic',
            style_class: 'system-status-icon lm-panel-icon',
        });

        const groups = {
            cpu: [this._icon('cpu'), this._spark],
            gpu: [this._icon('gpu')],
            memory: [this._icon('memory')],
            temperature: [this._icon('temperature')],
            battery: [this._batteryIcon],
            claude: [this._icon('claude')],
        };
        for (const [key, children] of Object.entries(groups)) {
            const group = new St.BoxLayout({style_class: 'lm-panel-group', y_align: Clutter.ActorAlign.CENTER});
            children.forEach(c => group.add_child(c));
            const value = label('…', 'lm-panel-value', {y_align: Clutter.ActorAlign.CENTER});
            group.add_child(value);
            box.add_child(group);
            this._panel[key] = {group, value};
        }
    }

    // A collapsible group in the scrolling part of the menu: a header button with
    // a chevron, and a body that hides when the group is collapsed. The header
    // shows `extra` while expanded and the compact `summary` while collapsed.
    // Which groups are collapsed is kept in the `collapsed-groups` setting.
    _addGroup(key, title, {extra = null, summary = null} = {}) {
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(label(title, 'lm-group-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        for (const child of [extra, summary].filter(Boolean))
            header.add_child(child);
        const chevron = new St.Icon({style_class: 'lm-group-chevron', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(chevron);
        const button = new St.Button({style_class: 'lm-group-header', child: header, x_expand: true, can_focus: true});
        button.connect('clicked', () => {
            const collapsed = this._settings.get_strv('collapsed-groups');
            this._settings.set_strv('collapsed-groups', collapsed.includes(key)
                ? collapsed.filter(k => k !== key)
                : [...collapsed, key]);
        });

        const body = vbox('lm-group-body', {x_expand: true});
        const group = vbox('lm-group', {x_expand: true});
        group.add_child(button);
        group.add_child(body);
        this._content.add_child(group);
        this._groups[key] = {body, chevron, extra, summary};
        return body;
    }

    _syncGroups() {
        const collapsed = this._settings.get_strv('collapsed-groups');
        for (const [key, {body, chevron, extra, summary}] of Object.entries(this._groups)) {
            body.visible = !collapsed.includes(key);
            chevron.icon_name = body.visible ? 'pan-down-symbolic' : 'pan-end-symbolic';
            if (extra)
                extra.visible = body.visible;
            if (summary)
                summary.visible = !body.visible;
        }
    }

    _summaryBox() {
        return new St.BoxLayout({style_class: 'lm-summary', y_align: Clutter.ActorAlign.CENTER});
    }

    // Overview summary: a mini ring and a value per metric.
    _buildOverviewSummary() {
        const box = this._summaryBox();
        this._chips = {};
        for (const key of ['cpu', 'gpu', 'memory', 'temperature', 'battery']) {
            const chip = new St.BoxLayout({style_class: 'lm-chip'});
            const ring = new MiniRing(key);
            const value = label('…', 'lm-chip-value', {y_align: Clutter.ActorAlign.CENTER});
            chip.add_child(ring.actor);
            chip.add_child(value);
            box.add_child(chip);
            this._chips[key] = {chip, ring, value};
        }
        return box;
    }

    _setChip(key, fraction, text, lvl) {
        const {ring, value} = this._chips[key];
        ring.set(fraction, lvl);
        value.text = text;
    }

    // Claude summary: session and weekly as mini bars.
    _buildClaudeSummary() {
        const box = this._summaryBox();
        this._claudeMini = {};
        for (const [kind, name] of [['session', '5h'], ['weekly_all', 'wk']]) {
            const chip = new St.BoxLayout({style_class: 'lm-chip'});
            chip.add_child(label(name, 'lm-chip-key', {y_align: Clutter.ActorAlign.CENTER}));
            const bar = new MiniBar('claude');
            chip.add_child(bar.actor);
            const value = label('…', 'lm-chip-value', {y_align: Clutter.ActorAlign.CENTER});
            chip.add_child(value);
            box.add_child(chip);
            this._claudeMini[kind] = {bar, value};
        }
        return box;
    }

    // Small title row inside a group, with optional content on the right.
    _subheader(title, extra) {
        const row = new St.BoxLayout({style_class: 'lm-subheader', x_expand: true});
        row.add_child(label(title, 'lm-subtitle', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(extra);
        return row;
    }

    // Top-bar summary: the icons of the items currently shown.
    _buildTopbarSummary() {
        const box = this._summaryBox();
        this._topbarIcons = {};
        for (const [key] of PANEL_ITEMS) {
            const icon = key === 'battery'
                ? new St.Icon({icon_name: 'battery-level-80-symbolic', style_class: 'lm-summary-icon'})
                : new St.Icon({gicon: this._gicon(key), style_class: 'lm-summary-icon'});
            box.add_child(icon);
            this._topbarIcons[key] = icon;
        }
        return box;
    }

    _buildMenu() {
        const menu = this._button.menu;
        menu.box.add_style_class_name('lm-menu');

        // Everything but the charge switch scrolls, so the menu fits on screen;
        // _onMenuOpened caps the height to the monitor.
        this._content = vbox('lm-content', {x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'lm-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._content,
        });
        const scrollItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'lm-item'});
        scrollItem.add_child(this._scroll);
        menu.addMenuItem(scrollItem);
        this._groups = {};

        // Two rows of three: usage on top, memory and battery below.
        this._gauges = {
            cpu: new Gauge('CPU', 'cpu', {warn: 70, crit: 90}),
            gpu: new Gauge('GPU', 'gpu', {warn: 70, crit: 90}),
            temperature: new Gauge('Temp', 'temperature', {min: 30, max: 100, warn: 80, crit: 90}),
            memory: new Gauge('Memory', 'memory', {warn: 80, crit: 92}),
            gpuMemory: new Gauge('GPU RAM', 'gpu', {warn: 80, crit: 92}),
            battery: new Gauge('Battery', 'battery', {warn: 20, crit: 10, inverted: true}),
        };
        const gaugeLayout = new Clutter.GridLayout({column_homogeneous: true, row_spacing: 6});
        const gauges = new St.Widget({layout_manager: gaugeLayout, style_class: 'lm-gauges', x_expand: true});
        Object.values(this._gauges).forEach((g, i) => gaugeLayout.attach(g.actor, i % 3, Math.floor(i / 3), 1, 1));
        this._gauges.battery.actor.visible = this._available.battery;
        const overview = this._addGroup('overview', 'OVERVIEW', {summary: this._buildOverviewSummary()});
        overview.add_child(gauges);

        // CPU threads, then the activity graph, under the gauges.
        this._threadStats = label('', 'lm-group-note', {y_align: Clutter.ActorAlign.CENTER});
        overview.add_child(this._subheader(`CPU THREADS (${this._stats.sample().cpu.threads})`, this._threadStats));
        this._cores = new CoreBars();
        overview.add_child(this._cores.actor);

        const legend = new St.BoxLayout({style_class: 'lm-legend', y_align: Clutter.ActorAlign.CENTER});
        this._legendValues = {};
        for (const key of ['cpu', 'gpu', 'memory']) {
            const [r, g, b] = COLORS[key].map(c => Math.round(c * 255));
            legend.add_child(new St.Widget({
                style_class: 'lm-dot',
                style: `background-color: rgb(${r},${g},${b});`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._legendValues[key] = label('', 'lm-legend-label', {y_align: Clutter.ActorAlign.CENTER});
            legend.add_child(this._legendValues[key]);
        }
        overview.add_child(this._subheader('LAST 3 MINUTES', legend));
        this._chart = new HistoryChart([
            {data: this._history.cpu, color: 'cpu', fill: 0.45},
            {data: this._history.memory, color: 'memory', fill: 0.14},
            {data: this._history.gpu, color: 'gpu', fill: 0.2},
        ]);
        overview.add_child(this._chart.actor);

        this._claudeStatus = label('', 'lm-group-note', {y_align: Clutter.ActorAlign.CENTER});
        this._claudeBox = vbox('lm-usage-list', {x_expand: true});
        this._claudeBars = new Map();
        this._addGroup('claude', 'CLAUDE PLAN USAGE', {extra: this._claudeStatus, summary: this._buildClaudeSummary()})
            .add_child(this._claudeBox);

        const layout = new Clutter.GridLayout({column_homogeneous: true, column_spacing: 6, row_spacing: 6});
        const grid = new St.Widget({layout_manager: layout, x_expand: true, style_class: 'lm-tiles'});
        this._tiles = {};
        const tiles = [
            ['load', 'Load average (1 / 5 / 15 min)'],
            ['swap', 'Swap'],
            ['gpuMemory', 'GPU memory (VRAM · shared)'],
            ['gpuInfo', 'GPU clock · temp · chip power'],
            ['power', 'Battery power'],
            ['time', 'Battery time'],
            ['drained', 'Used on battery'],
            ['health', 'Battery health'],
        ];
        tiles.forEach(([key, title], i) => {
            const tile = vbox('lm-tile', {x_expand: true});
            tile.add_child(label(title, 'lm-tile-key'));
            this._tiles[key] = label('—', 'lm-tile-value');
            tile.add_child(this._tiles[key]);
            layout.attach(tile, i % 2, Math.floor(i / 2), 1, 1);
        });
        this._detailsSummary = label('', 'lm-chip-value', {y_align: Clutter.ActorAlign.CENTER});
        this._addGroup('details', 'DETAILS', {summary: this._detailsSummary}).add_child(grid);

        const checkLayout = new Clutter.GridLayout({column_homogeneous: true, column_spacing: 4, row_spacing: 2});
        const checks = new St.Widget({layout_manager: checkLayout, x_expand: true});
        this._panelToggles = {};
        PANEL_ITEMS.forEach(([key, title], i) => {
            const row = new St.BoxLayout({x_expand: true});
            const check = new St.Icon({icon_name: 'object-select-symbolic', style_class: 'lm-check'});
            row.add_child(check);
            row.add_child(label(title, 'lm-check-label', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            const button = new St.Button({style_class: 'lm-check-row', child: row, x_expand: true, can_focus: true});
            button.connect('clicked', () => this._togglePanelItem(key));
            checkLayout.attach(button, i % 2, Math.floor(i / 2), 1, 1);
            this._panelToggles[key] = {button, check};
        });
        this._addGroup('topbar', 'SHOW IN TOP BAR', {summary: this._buildTopbarSummary()}).add_child(checks);

        this._syncGroups();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._limitSwitch = new PopupMenu.PopupSwitchMenuItem('Limit charge to ~80%', false);
        this._limitSwitch.connect('toggled', (_item, state) => this._setChargeLimit(state));
        this._limitSwitch.setSensitive(!!this._stats.conservationPath);
        menu.addMenuItem(this._limitSwitch);
    }

    _togglePanelItem(key) {
        const items = this._settings.get_strv('panel-items');
        const next = items.includes(key) ? items.filter(k => k !== key) : [...items, key];
        this._settings.set_strv('panel-items', next);
    }

    _syncPanelItems() {
        const items = this._settings.get_strv('panel-items');
        let shown = 0;
        for (const [key, {group}] of Object.entries(this._panel)) {
            group.visible = items.includes(key) && this._available[key];
            shown += group.visible;
            const {button, check} = this._panelToggles[key];
            check.opacity = items.includes(key) ? 255 : 0;
            button.reactive = this._available[key];
            button.opacity = this._available[key] ? 255 : 110;
            this._topbarIcons[key].visible = items.includes(key) && this._available[key];
        }
        // Keep something clickable in the bar when everything is unticked.
        if (!shown)
            this._panel.cpu.group.visible = true;
    }

    _setPanel(key, text, lvl) {
        const {value} = this._panel[key];
        value.text = text;
        value.remove_style_class_name('lm-warn');
        value.remove_style_class_name('lm-crit');
        if (lvl !== 'ok')
            value.add_style_class_name(`lm-${lvl}`);
    }

    _update() {
        const {cpu, gpu, memory, battery, chargeLimit} = this._stats.sample();

        pushHistory(this._history.cpu, cpu.usage);
        const usage = cpu.usage !== null ? `${Math.round(cpu.usage)}%` : '…';
        const cpuLevel = level(cpu.usage ?? 0, 70, 90);
        this._setPanel('cpu', usage, cpuLevel);
        this._gauges.cpu.set(cpu.usage, usage, cpu.ghz !== null ? `${cpu.ghz.toFixed(2)} GHz` : '', cpuLevel,
            peakOf(this._history.cpu));
        this._setChip('cpu', (cpu.usage ?? 0) / 100, usage, cpuLevel);
        this._cores.values = cpu.cores;
        this._tiles.load.text = cpu.load.map(l => l.toFixed(2)).join(' / ');
        const threads = cpu.cores.filter(v => v !== null);
        if (threads.length) {
            const avg = threads.reduce((a, v) => a + v, 0) / threads.length;
            this._threadStats.text = `avg ${Math.round(avg)}% · max ${Math.round(Math.max(...threads))}%`;
        }
        this._legendValues.cpu.text = `CPU ${usage}`;

        this._available.gpu = gpu !== null;
        this._gauges.gpu.actor.visible = this._gauges.gpuMemory.actor.visible = gpu !== null;
        this._chips.gpu.chip.visible = gpu !== null;
        if (gpu)
            this._updateGpu(gpu);

        const memPct = memory.total ? 100 * memory.used / memory.total : 0;
        pushHistory(this._history.memory, memPct);
        const memLevel = level(memPct, 80, 92);
        this._setPanel('memory', `${Math.round(memPct)}%`, memLevel);
        this._gauges.memory.set(memPct, `${Math.round(memPct)}%`,
            `${fmtGB(memory.used)} / ${fmtGB(memory.total)} GB`, memLevel, peakOf(this._history.memory));
        this._setChip('memory', memPct / 100, `${Math.round(memPct)}%`, memLevel);
        this._legendValues.memory.text = `Memory ${Math.round(memPct)}%`;
        this._tiles.swap.text = memory.swapTotal
            ? `${fmtGB(memory.swapUsed)} / ${fmtGB(memory.swapTotal)} GB`
            : 'none';

        this._available.temperature = cpu.tempC !== null;
        this._chips.temperature.chip.visible = cpu.tempC !== null;
        if (cpu.tempC !== null) {
            pushHistory(this._history.temperature, cpu.tempC);
            const peak = peakOf(this._history.temperature);
            const tempLevel = level(cpu.tempC, 80, 90);
            this._setPanel('temperature', `${Math.round(cpu.tempC)}°`, tempLevel);
            this._gauges.temperature.set(cpu.tempC, `${Math.round(cpu.tempC)}°`,
                `3-min peak ${Math.round(peak)}°`, tempLevel, peak);
            this._setChip('temperature', (cpu.tempC - 30) / 70, `${Math.round(cpu.tempC)}°`, tempLevel);
        } else {
            this._gauges.temperature.set(null, '—', 'no sensor', 'ok');
        }

        this._chips.battery.chip.visible = !!battery;
        if (battery)
            this._updateBattery(battery, chargeLimit);
        if (chargeLimit !== null && !this._writing)
            this._limitSwitch.setToggleState(chargeLimit);

        const details = [memory.swapTotal ? `swap ${fmtGB(memory.swapUsed)} GB` : null, ...this._batteryBrief ?? []];
        this._detailsSummary.text = details.filter(Boolean).join(' · ');

        this._spark.queue_repaint();
        if (this._button.menu.isOpen) {
            this._chart.actor.queue_repaint();
            this._cores.actor.queue_repaint();
            this._updateClaude();
        }
    }

    _updateGpu(gpu) {
        pushHistory(this._history.gpu, gpu.busy);
        const busy = gpu.busy !== null ? `${Math.round(gpu.busy)}%` : '…';
        const busyLevel = level(gpu.busy ?? 0, 70, 90);
        this._setPanel('gpu', busy, busyLevel);
        this._gauges.gpu.set(gpu.busy, busy, gpu.mhz !== null ? `${Math.round(gpu.mhz)} MHz` : '', busyLevel,
            peakOf(this._history.gpu));
        this._setChip('gpu', (gpu.busy ?? 0) / 100, busy, busyLevel);
        this._legendValues.gpu.text = `GPU ${busy}`;

        const used = gpu.vramUsed + gpu.gttUsed;
        const total = gpu.vramTotal + gpu.gttTotal;
        const memPct = total ? 100 * used / total : 0;
        this._gauges.gpuMemory.set(memPct, `${Math.round(memPct)}%`,
            `${fmtGB(used)} / ${fmtGB(total)} GB`, level(memPct, 80, 92));
        const mb = bytes => Math.round(bytes / 1024 ** 2);
        this._tiles.gpuMemory.text =
            `${mb(gpu.vramUsed)} / ${mb(gpu.vramTotal)} MB · ${fmtGB(gpu.gttUsed)} / ${fmtGB(gpu.gttTotal)} GB`;

        const info = [];
        if (gpu.mhz !== null)
            info.push(`${Math.round(gpu.mhz)} MHz`);
        if (gpu.tempC !== null)
            info.push(`${Math.round(gpu.tempC)}°`);
        if (gpu.watts !== null)
            info.push(`${gpu.watts.toFixed(1)} W`);
        this._tiles.gpuInfo.text = info.join(' · ') || '—';
    }

    _updateBattery(bat, chargeLimit) {
        const watts = Math.abs(bat.watts);
        const discharging = bat.status === 'Discharging';
        let batLevel = 'ok';
        if (discharging)
            batLevel = bat.capacity <= 10 ? 'crit' : bat.capacity <= 20 ? 'warn' : 'ok';

        this._batteryIcon.icon_name = batteryIconName(bat);
        this._setPanel('battery', `${bat.capacity}%`, batLevel);

        let power, time;
        if (discharging) {
            power = `−${watts.toFixed(1)} W`;
            const hours = watts > 0.5 ? bat.energyNow / watts : null;
            time = hours !== null ? `≈ ${fmtDuration(hours * 60)} left` : '—';
        } else if (bat.status === 'Charging') {
            power = `+${watts.toFixed(1)} W`;
            const target = bat.energyFull * (chargeLimit ? 0.8 : 1);
            const hours = watts > 0.5 && target > bat.energyNow ? (target - bat.energyNow) / watts : null;
            time = hours !== null ? `≈ ${fmtDuration(hours * 60)} to ${chargeLimit ? '~80%' : 'full'}` : '—';
        } else {
            power = bat.acOnline ? 'Plugged in' : `${watts.toFixed(1)} W`;
            time = chargeLimit && bat.acOnline ? 'Holding at charge limit' : '—';
        }
        this._gauges.battery.set(bat.capacity, `${bat.capacity}%`, power, batLevel);
        this._setChip('battery', bat.capacity / 100, `${bat.capacity}%`, batLevel);
        this._tiles.power.text = discharging || bat.status === 'Charging'
            ? `${power} · ${bat.status.toLowerCase()}`
            : power;
        this._tiles.time.text = time;

        const d = bat.drained;
        if (d) {
            const wh = d.wh !== null ? ` · ${d.wh.toFixed(1)} Wh` : '';
            this._tiles.drained.text = `${d.percent}%${wh} in ${fmtDuration(d.minutes)}`;
        } else {
            this._tiles.drained.text = 'On charger';
        }

        const health = bat.energyFull && bat.energyDesign
            ? `${Math.round(100 * bat.energyFull / bat.energyDesign)}%`
            : '—';
        this._tiles.health.text = bat.cycles !== null ? `${health} · ${bat.cycles} cycles` : health;
        this._batteryBrief = [time !== '—' ? time.replace('≈ ', '') : null, health !== '—' ? `health ${health}` : null];
    }

    async _refreshClaude() {
        // Every request restarts the countdown, so requests stay at least
        // CLAUDE_REFRESH_SECONDS apart even when opening the menu triggers one.
        if (this._claudeTimerId)
            GLib.source_remove(this._claudeTimerId);
        this._claudeTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CLAUDE_REFRESH_SECONDS, () => {
            this._claudeTimerId = 0;
            this._refreshClaude();
            return GLib.SOURCE_REMOVE;
        });
        await this._claude.refresh();
        if (!this._destroyed)
            this._updateClaude();
    }

    _updateClaude() {
        const {limits, error, session, weekly, updatedAt} = this._claude;

        if (session) {
            const top = Math.max(session.percent, weekly?.percent ?? 0);
            const text = weekly
                ? `${Math.round(session.percent)}% · ${Math.round(weekly.percent)}%`
                : `${Math.round(session.percent)}%`;
            this._setPanel('claude', text, level(top, 75, 90));
        } else {
            this._setPanel('claude', error ? '!' : '…', error ? 'warn' : 'ok');
        }

        const kinds = (limits ?? []).map(l => l.kind).join();
        if (kinds !== this._claudeKinds) {
            this._claudeKinds = kinds;
            this._claudeBox.destroy_all_children();
            this._claudeBars.clear();
            for (const l of limits ?? []) {
                const bar = new UsageBar(l.label);
                this._claudeBox.add_child(bar.actor);
                this._claudeBars.set(l.kind, bar);
            }
        }
        for (const l of limits ?? [])
            this._claudeBars.get(l.kind).set(l.percent, fmtReset(l.resetsAt));
        for (const [kind, {bar, value}] of Object.entries(this._claudeMini)) {
            const l = limits?.find(x => x.kind === kind);
            bar.set(l ? l.percent / 100 : 0, l ? level(l.percent, 75, 90) : 'ok');
            value.text = l ? `${Math.round(l.percent)}%` : error ? '!' : '…';
        }

        if (error) {
            this._claudeStatus.text = error;
        } else if (updatedAt) {
            const minutes = Math.floor((Date.now() - updatedAt) / 60000);
            this._claudeStatus.text = minutes ? `updated ${minutes} min ago` : 'updated just now';
        }
    }

    _onMenuOpened() {
        // Leave room for the top bar, the charge switch and the menu's margins.
        const monitor = Main.layoutManager.findMonitorForActor(this._button) ?? Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        this._scroll.style = `max-height: ${Math.max(240, workArea.height - 150)}px;`;

        this._chart.actor.queue_repaint();
        this._cores.actor.queue_repaint();
        this._updateClaude();
        if (Date.now() - this._claude.updatedAt >= CLAUDE_REFRESH_SECONDS * 1000)
            this._refreshClaude();
    }

    _setChargeLimit(enabled) {
        const path = this._stats.conservationPath;
        this._writing = true;
        // sysfs needs an in-place write; Gio/GLib replace helpers use a temp file + rename.
        const proc = Gio.Subprocess.new(
            ['/bin/sh', '-c', 'echo "$1" > "$2"', 'sh', enabled ? '1' : '0', path],
            Gio.SubprocessFlags.STDERR_PIPE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, , stderr] = p.communicate_utf8_finish(res);
                if (!p.get_successful())
                    throw new Error(stderr.trim() || 'write failed');
            } catch (e) {
                Main.notifyError('Could not change the battery charge limit', e.message);
            }
            this._writing = false;
            if (!this._destroyed)
                this._update();
        });
    }

    destroy() {
        this._destroyed = true;
        GLib.source_remove(this._timerId);
        if (this._claudeTimerId)
            GLib.source_remove(this._claudeTimerId);
        this._settings.disconnect(this._settingsId);
        this._settings.disconnect(this._groupsId);
        this._claude.destroy();
        this._button.destroy();
    }
}
