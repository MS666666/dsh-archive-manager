/**
 * HTTP routes bridging the archive-management settings page to the host.
 * This layer only parses requests, calls the storage helpers, and serializes
 * responses — all filesystem work lives below in this module.
 *
 * Security: the delete route removes files, so it accepts only same-origin
 * POSTs and strictly validates session ids before touching the filesystem.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Only ids shaped like `session-<hex/dash>` are ever touched by delete. */
const SESSION_ID_RE = /^session-[0-9a-fA-F-]+$/;

function dshHome() {
    const home = process.env.DSH_HOME;
    if (!home) throw new Error('DSH_HOME is not set');
    return home;
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
}

function isSameOrigin(request) {
    const origin = request.headers['origin'];
    if (origin === undefined) return true;
    try {
        return new URL(origin).host === request.headers['host'];
    }
    catch {
        return false;
    }
}

function readJsonBody(request, maxBytes = 65536) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let done = false;
        request.on('data', (chunk) => {
            if (done) return;
            size += chunk.length;
            if (size > maxBytes) {
                done = true;
                reject(new Error('request body too large'));
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (done) return;
            done = true;
            const text = Buffer.concat(chunks).toString('utf8');
            if (text.trim() === '') {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(text));
            }
            catch (error) {
                reject(new Error(`invalid json body: ${error.message}`));
            }
        });
        request.on('error', reject);
    });
}

/**
 * Every session directory lives under $DSH_HOME/sessions/<encoded-workspace>/<session-id>/.
 * We scan rather than guess the workspace-path encoding, so a session is
 * found wherever it actually sits.
 */
function sessionDirOnDisk(home, sessionId) {
    const sessionsRoot = join(home, 'sessions');
    if (!existsSync(sessionsRoot)) return null;
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(sessionsRoot, entry.name, sessionId);
        if (existsSync(dir)) return dir;
    }
    return null;
}

/** Cache-folder summaries from the projection cache, keyed by session id. */
function readTitleCache(home) {
    const path = join(home, 'storages', 'session_projcache.json');
    if (!existsSync(path)) return {};
    try {
        const cache = readJson(path);
        const out = {};
        for (const [id, record] of Object.entries(cache.tables?.sessions ?? {})) {
            const title = record.rows?.title?.val;
            const createdAt = record.identity?.createdAt;
            out[id] = {
                title: typeof title === 'string' ? title : undefined,
                createdAt: typeof createdAt === 'number' ? createdAt : undefined,
            };
        }
        return out;
    }
    catch {
        return {};
    }
}

/**
 * List archived sessions: ids from the registry-global archive set, enriched
 * with cached titles and whether the on-disk log still exists.
 */
export function listArchivedSessions() {
    const home = dshHome();
    const workspacePath = join(home, 'storages', 'workspace.json');
    const workspace = existsSync(workspacePath) ? readJson(workspacePath) : null;
    const archived = workspace?.global?.archivedSessionIds ?? [];
    const titles = readTitleCache(home);
    return archived.map((sessionId) => ({
        sessionId,
        title: titles[sessionId]?.title ?? null,
        createdAt: titles[sessionId]?.createdAt ?? null,
        onDisk: sessionDirOnDisk(home, sessionId) !== null,
    }));
}

/**
 * Delete ONE archived session for real:
 * 1. remove the id from the registry archive set,
 * 2. drop it from every workspace's session list,
 * 3. remove the on-disk session directory,
 * 4. drop its projections from the cache file.
 *
 * Live host-side state (session.list rows, running agent) is intentionally
 * left alone — the file and registry layers are the durable truth, and the
 * UI re-fetches on the next reload. Deleting a session that is currently
 * running is therefore caller's responsibility.
 */
export function deleteArchivedSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        throw new Error(`invalid session id: ${sessionId}`);
    }
    const home = dshHome();
    const workspacePath = join(home, 'storages', 'workspace.json');

    // 1–2. Registry accounting: archive set + per-workspace session lists.
    const workspace = existsSync(workspacePath) ? readJson(workspacePath) : null;
    if (workspace !== null) {
        let changed = false;
        const archived = workspace.global?.archivedSessionIds;
        if (Array.isArray(archived) && archived.includes(sessionId)) {
            workspace.global.archivedSessionIds = archived.filter((id) => id !== sessionId);
            changed = true;
        }
        const tables = workspace.tables?.workspaces ?? {};
        for (const record of Object.values(tables)) {
            if (Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId)) {
                record.sessionIds = record.sessionIds.filter((id) => id !== sessionId);
                changed = true;
            }
        }
        if (changed) writeJson(workspacePath, workspace);
    }

    // 3. On-disk session directory.
    const dir = sessionDirOnDisk(home, sessionId);
    if (dir !== null) rmSync(dir, { recursive: true, force: true });

    // 4. Projection cache entry.
    const cachePath = join(home, 'storages', 'session_projcache.json');
    if (existsSync(cachePath)) {
        try {
            const cache = readJson(cachePath);
            const sessions = cache.tables?.sessions;
            if (sessions && sessionId in sessions) {
                delete sessions[sessionId];
                writeJson(cachePath, cache);
            }
        }
        catch {
            // Best-effort only; a corrupt cache never blocks deletion.
        }
    }

    return { deleted: true };
}

/** Mount the archive-management routes; returns a disposer that unmounts them. */
export function mountArchiveRoutes(host) {
    const disposers = [
        host.webServer.register({
            kind: 'exact',
            path: '/dsh-archive-manager-plus/list',
            handler: (request, response) => {
                if (request.method !== 'GET') {
                    response.writeHead(405, { allow: 'GET' });
                    response.end();
                    return;
                }
                try {
                    sendJson(response, 200, { ok: true, sessions: listArchivedSessions() });
                }
                catch (error) {
                    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }),
        host.webServer.register({
            kind: 'exact',
            path: '/dsh-archive-manager-plus/delete',
            handler: async (request, response) => {
                if (request.method !== 'POST') {
                    response.writeHead(405, { allow: 'POST' });
                    response.end();
                    return;
                }
                if (!isSameOrigin(request)) {
                    sendJson(response, 403, { error: 'untrusted origin' });
                    return;
                }
                try {
                    const body = await readJsonBody(request);
                    const sessionId = body?.sessionId;
                    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
                        sendJson(response, 400, { error: 'invalid session id' });
                        return;
                    }
                    sendJson(response, 200, deleteArchivedSession(sessionId));
                }
                catch (error) {
                    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }),
    ];
    return () => {
        for (const dispose of disposers) dispose();
    };
}