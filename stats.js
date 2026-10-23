// Reads CPU, GPU, memory and battery numbers from /proc and /sys.
// Only depends on GLib/Gio so it can be tested with `gjs -m` outside GNOME Shell.
//
// Every periodic read is asynchronous. Battery and charge-limit files are
// answered by the laptop's embedded controller, which can take seconds to
// reply; a synchronous read would freeze GNOME Shell for that long.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decoder = new TextDecoder();

// Synchronous read, only for the one-time hardware discovery below.
function readText(path) {
    if (!path)
        return null;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch {
        return null;
    }
}

function readTextAsync(path) {
    if (!path)
        return Promise.resolve(null);
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                resolve(decoder.decode(bytes).trim());
            } catch {
                resolve(null);
            }
        });
    });
}

function toNumber(text) {
    if (text === null || text === '')
        return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
}

const readNumberAsync = async path => toNumber(await readTextAsync(path));

function listDir(path) {
    try {
        const dir = GLib.Dir.open(path, 0);
        const names = [];
        let name;
        while ((name = dir.read_name()) !== null)
            names.push(name);
        dir.close();
        return names.sort();
    } catch {
        return [];
    }
}

function findPowerSupply(type) {
    const root = '/sys/class/power_supply';
    const name = listDir(root).find(n => readText(`${root}/${n}/type`) === type);
    return name ? `${root}/${name}` : null;
}

function findCpuTemp() {
    const root = '/sys/class/hwmon';
    for (const wanted of ['k10temp', 'coretemp', 'zenpower']) {
        const name = listDir(root).find(n => readText(`${root}/${n}/name`) === wanted);
        if (name)
            return `${root}/${name}/temp1_input`;
    }
    return null;
}

// First amdgpu card (the Radeon 780M on this laptop) and its hwmon directory.
function findGpu() {
    const root = '/sys/class/drm';
    for (const name of listDir(root).filter(n => /^card\d+$/.test(n))) {
        const device = `${root}/${name}/device`;
        if (!GLib.file_test(`${device}/gpu_busy_percent`, GLib.FileTest.EXISTS))
            continue;
        const hwmon = listDir(`${device}/hwmon`).find(n => readText(`${device}/hwmon/${n}/name`) === 'amdgpu');
        return {device, hwmon: hwmon ? `${device}/hwmon/${hwmon}` : null};
    }
    return null;
}

function findConservationMode() {
    const root = '/sys/bus/platform/drivers/ideapad_acpi';
    for (const name of listDir(root)) {
        const path = `${root}/${name}/conservation_mode`;
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }
    return null;
}

export class Stats {
    constructor() {
        this.batteryPath = findPowerSupply('Battery');
        this.acPath = findPowerSupply('Mains');
        this.conservationPath = findConservationMode();
        this.threads = GLib.get_num_processors();
        this._cpuTempPath = findCpuTemp();
        this._gpu = findGpu();
        this._prevCpu = null;
        this._onBatterySince = null;
    }

    async sample() {
        const [cpu, gpu, memory, battery, chargeLimit] = await Promise.all([
            this._sampleCpu(),
            this._sampleGpu(),
            this._sampleMemory(),
            this._sampleBattery(),
            this._sampleChargeLimit(),
        ]);
        return {cpu, gpu, memory, battery, chargeLimit};
    }

    async _sampleChargeLimit() {
        if (!this.conservationPath)
            return null;
        const value = await readNumberAsync(this.conservationPath);
        return value === null ? null : value === 1;
    }

    // An APU has a small fixed VRAM carve-out plus GTT, system RAM the GPU
    // borrows on demand; together they are what the GPU can use.
    async _sampleGpu() {
        if (!this._gpu)
            return null;
        const {device, hwmon} = this._gpu;
        const sensor = async (file, scale) => {
            const n = hwmon ? await readNumberAsync(`${hwmon}/${file}`) : null;
            return n !== null ? n / scale : null;
        };
        const [busy, vramUsed, vramTotal, gttUsed, gttTotal, tempC, mhz, watts] = await Promise.all([
            readNumberAsync(`${device}/gpu_busy_percent`),
            readNumberAsync(`${device}/mem_info_vram_used`),
            readNumberAsync(`${device}/mem_info_vram_total`),
            readNumberAsync(`${device}/mem_info_gtt_used`),
            readNumberAsync(`${device}/mem_info_gtt_total`),
            sensor('temp1_input', 1000),
            sensor('freq1_input', 1e6),
            sensor('power1_average', 1e6),
        ]);
        return {
            busy,
            vramUsed: vramUsed ?? 0,
            vramTotal: vramTotal ?? 0,
            gttUsed: gttUsed ?? 0,
            gttTotal: gttTotal ?? 0,
            tempC,
            mhz,
            watts,
        };
    }

    async _sampleCpu() {
        const freqFiles = Array.from({length: this.threads},
            (_, i) => `/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
        const [stat, loadavg, temp, ...freqs] = await Promise.all([
            readTextAsync('/proc/stat'),
            readTextAsync('/proc/loadavg'),
            readNumberAsync(this._cpuTempPath),
            ...freqFiles.map(readNumberAsync),
        ]);

        // Line 0 is the all-CPU total, then one line per thread (cpu0, cpu1, ...).
        const times = (stat ?? '').split('\n')
            .filter(line => line.startsWith('cpu'))
            .map(line => {
                const fields = line.split(/\s+/).slice(1, 9).map(Number);
                return {total: fields.reduce((a, b) => a + b, 0), idle: fields[3] + fields[4]};
            });
        const usage = times.map((t, i) => {
            const prev = this._prevCpu?.[i];
            return prev && t.total > prev.total
                ? 100 * (1 - (t.idle - prev.idle) / (t.total - prev.total))
                : null;
        });
        this._prevCpu = times;

        const khz = freqs.filter(f => f !== null);
        return {
            usage: usage[0] ?? null,
            cores: usage.slice(1),
            threads: this.threads,
            load: (loadavg ?? '').split(' ').slice(0, 3).map(Number),
            ghz: khz.length ? khz.reduce((a, b) => a + b, 0) / khz.length / 1e6 : null,
            tempC: temp !== null ? temp / 1000 : null,
        };
    }

    async _sampleMemory() {
        const m = {};
        for (const line of (await readTextAsync('/proc/meminfo') ?? '').split('\n')) {
            const match = line.match(/^(\w+):\s+(\d+)/);
            if (match)
                m[match[1]] = Number(match[2]) * 1024;
        }
        return {
            total: m.MemTotal ?? 0,
            used: (m.MemTotal ?? 0) - (m.MemAvailable ?? 0),
            swapTotal: m.SwapTotal ?? 0,
            swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
        };
    }

    // Energy in Wh and power in W; falls back to charge * voltage on batteries
    // that only report charge_* / current_now.
    async _sampleBattery() {
        const bat = this.batteryPath;
        if (!bat)
            return null;

        const keys = ['voltage_now', 'power_now', 'current_now', 'capacity', 'cycle_count',
            'energy_now', 'energy_full', 'energy_full_design',
            'charge_now', 'charge_full', 'charge_full_design'];
        const [status, online, ...values] = await Promise.all([
            readTextAsync(`${bat}/status`),
            this.acPath ? readNumberAsync(`${this.acPath}/online`) : null,
            ...keys.map(k => readNumberAsync(`${bat}/${k}`)),
        ]);
        const v = Object.fromEntries(keys.map((k, i) => [k, values[i]]));

        const volts = (v.voltage_now ?? 0) / 1e6;
        const energy = key => {
            if (v[`energy_${key}`] !== null)
                return v[`energy_${key}`] / 1e6;
            const c = v[`charge_${key}`];
            return c !== null ? c / 1e6 * volts : null;
        };
        const watts = v.power_now !== null
            ? v.power_now / 1e6
            : (v.current_now ?? 0) / 1e6 * volts;

        const state = status ?? 'Unknown';
        const acOnline = this.acPath ? online === 1 : state !== 'Discharging';
        const now = energy('now');
        const capacity = v.capacity;

        // Track how much has been used since the laptop went on battery.
        if (!acOnline && !this._onBatterySince)
            this._onBatterySince = {time: GLib.get_real_time(), energy: now, capacity};
        else if (acOnline)
            this._onBatterySince = null;

        let drained = null;
        if (this._onBatterySince) {
            const start = this._onBatterySince;
            drained = {
                since: GLib.DateTime.new_from_unix_local(Math.floor(start.time / 1e6)),
                minutes: (GLib.get_real_time() - start.time) / 6e7,
                percent: start.capacity - capacity,
                wh: start.energy !== null && now !== null ? start.energy - now : null,
            };
        }

        return {
            status: state,
            acOnline,
            capacity,
            watts,
            energyNow: now,
            energyFull: energy('full'),
            energyDesign: energy('full_design'),
            cycles: v.cycle_count,
            drained,
        };
    }
}
