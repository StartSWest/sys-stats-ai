// Claude plan limits (5-hour session, weekly) from the endpoint behind Claude
// Code's /usage, using the OAuth login Claude Code keeps in
// ~/.claude/.credentials.json. The token is only read, never refreshed, so
// Claude Code stays in charge of the login.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const decoder = new TextDecoder();

function limitLabel(limit) {
    switch (limit.kind) {
    case 'session':
        return 'Session (5 h)';
    case 'weekly_all':
        return 'Weekly · all models';
    case 'weekly_scoped':
        return `Weekly · ${limit.scope?.model?.display_name ?? 'scoped'}`;
    default:
        return limit.kind;
    }
}

function parseLimits(json) {
    if (Array.isArray(json.limits) && json.limits.length) {
        return json.limits.map(l => ({
            kind: l.kind,
            label: limitLabel(l),
            percent: l.percent,
            resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
        }));
    }
    // Older responses only have the fixed windows.
    return [['session', json.five_hour], ['weekly_all', json.seven_day]]
        .filter(([, w]) => w)
        .map(([kind, w]) => ({
            kind,
            label: limitLabel({kind}),
            percent: w.utilization,
            resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
        }));
}

export class ClaudeUsage {
    constructor() {
        this.limits = null;
        this.error = null;
        this.updatedAt = 0;
        this._http = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();
    }

    get session() {
        return this.limits?.find(l => l.kind === 'session') ?? null;
    }

    get weekly() {
        return this.limits?.find(l => l.kind === 'weekly_all') ?? null;
    }

    _readToken() {
        let oauth;
        try {
            const [, bytes] = GLib.file_get_contents(CREDENTIALS);
            oauth = JSON.parse(decoder.decode(bytes)).claudeAiOauth;
        } catch {
            oauth = null;
        }
        if (!oauth?.accessToken)
            throw new Error('Not signed in to Claude Code');
        if (oauth.expiresAt && oauth.expiresAt < Date.now())
            throw new Error('Login expired. Run claude to renew it');
        return oauth.accessToken;
    }

    _send(msg) {
        return new Promise((resolve, reject) => {
            this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
                try {
                    resolve(session.send_and_read_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async refresh() {
        try {
            const msg = Soup.Message.new('GET', USAGE_URL);
            msg.request_headers.append('Authorization', `Bearer ${this._readToken()}`);
            msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
            const bytes = await this._send(msg);
            const status = msg.get_status();
            if (status === 401)
                throw new Error('Login expired. Run claude to renew it');
            if (status !== 200)
                throw new Error(`Usage request failed (HTTP ${status})`);
            this.limits = parseLimits(JSON.parse(decoder.decode(bytes.get_data())));
            this.error = null;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this.error = e.message;
        }
        this.updatedAt = Date.now();
    }

    // Stop any request in flight and forget the last result.
    cancel() {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        this.limits = null;
        this.error = null;
        this.updatedAt = 0;
    }

    destroy() {
        this._cancellable.cancel();
        this._http.abort();
    }
}
