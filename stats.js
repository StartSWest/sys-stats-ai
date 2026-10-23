// Reads CPU, memory and battery numbers from /proc and /sys.
// Only depends on GLib so it can be tested with `gjs -m` outside GNOME Shell.
import GLib from 'gi://GLib';

const decoder = new TextDecoder();

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

function readNumber(path) {
    const text = readText(path);
    if (text === null || text === '')
        return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
}

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

function parseMeminfo() {
    const info = {};
    for (const line of (readText('/proc/meminfo') ?? '').split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m)
            info[m[1]] = Number(m[2]) * 1024;
    }
    return info;
}

export class Stats {
    constructor() {
        this.batteryPath = findPowerSupply('Battery');
        this.acPath = findPowerSupply('Mains');
        this.conservationPath = findConservationMode();
        this._cpuTempPath = findCpuTemp();
        this._gpu = findGpu();
        this._cpuCount = GLib.get_num_processors();
        this._prevCpu = null;
        this._onBatterySince = null;
    }

    sample() {
        return {
            cpu: this._sampleCpu(),
            gpu: this._sampleGpu(),
            memory: this._sampleMemory(),
            battery: this._sampleBattery(),
            chargeLimit: this.conservationPath ? readNumber(this.conservationPath) === 1 : null,
        };
    }

    // An APU has a small fixed VRAM carve-out plus GTT, system RAM the GPU
    // borrows on demand; together they are what the GPU can use.
    _sampleGpu() {
        if (!this._gpu)
            return null;
        const {device, hwmon} = this._gpu;
        const sensor = (file, scale) => {
            const n = hwmon ? readNumber(`${hwmon}/${file}`) : null;
            return n !== null ? n / scale : null;
        };
        return {
            busy: readNumber(`${device}/gpu_busy_percent`),
            vramUsed: readNumber(`${device}/mem_info_vram_used`) ?? 0,
            vramTotal: readNumber(`${device}/mem_info_vram_total`) ?? 0,
            gttUsed: readNumber(`${device}/mem_info_gtt_used`) ?? 0,
            gttTotal: readNumber(`${device}/mem_info_gtt_total`) ?? 0,
            tempC: sensor('temp1_input', 1000),
            mhz: sensor('freq1_input', 1e6),
            watts: sensor('power1_average', 1e6),
        };
    }

    _sampleCpu() {
        // Line 0 is the all-CPU total, then one line per thread (cpu0, cpu1, ...).
        const times = (readText('/proc/stat') ?? '').split('\n')
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

        let freqSum = 0, freqCount = 0;
        for (let i = 0; i < this._cpuCount; i++) {
            const khz = readNumber(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
            if (khz !== null) {
                freqSum += khz;
                freqCount++;
            }
        }

        const temp = readNumber(this._cpuTempPath);
        return {
            usage: usage[0] ?? null,
            cores: usage.slice(1),
            threads: this._cpuCount,
            load: (readText('/proc/loadavg') ?? '').split(' ').slice(0, 3).map(Number),
            ghz: freqCount ? freqSum / freqCount / 1e6 : null,
            tempC: temp !== null ? temp / 1000 : null,
        };
    }

    _sampleMemory() {
        const m = parseMeminfo();
        return {
            total: m.MemTotal ?? 0,
            used: (m.MemTotal ?? 0) - (m.MemAvailable ?? 0),
            swapTotal: m.SwapTotal ?? 0,
            swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
        };
    }

    // Energy in Wh and power in W; falls back to charge * voltage on batteries
    // that only report charge_* / current_now.
    _sampleBattery() {
        const bat = this.batteryPath;
        if (!bat)
            return null;

        const volts = (readNumber(`${bat}/voltage_now`) ?? 0) / 1e6;
        const energy = key => {
            const e = readNumber(`${bat}/energy_${key}`);
            if (e !== null)
                return e / 1e6;
            const c = readNumber(`${bat}/charge_${key}`);
            return c !== null ? c / 1e6 * volts : null;
        };
        let watts = readNumber(`${bat}/power_now`);
        if (watts !== null)
            watts /= 1e6;
        else
            watts = (readNumber(`${bat}/current_now`) ?? 0) / 1e6 * volts;

        const status = readText(`${bat}/status`) ?? 'Unknown';
        const acOnline = this.acPath ? readNumber(`${this.acPath}/online`) === 1 : status !== 'Discharging';
        const now = energy('now');
        const capacity = readNumber(`${bat}/capacity`);

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
            status,
            acOnline,
            capacity,
            watts,
            energyNow: now,
            energyFull: energy('full'),
            energyDesign: energy('full_design'),
            cycles: readNumber(`${bat}/cycle_count`),
            drained,
        };
    }
}
