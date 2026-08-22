/**
 * HTTP routes bridging the archive-management settings page to the host.
 * This layer only parses requests, calls the storage helpers, and serializes
 * responses — all filesystem work lives below in this module.
 *
 * Security: the delete route removes files, so it accepts only same-origin
 * POSTs and strictly validates session ids before touching the filesystem.
 * It also refuses ids that are not registered in the archive set: deleting
 * an un-archived session could destroy a live one, so only ids the list
 * endpoint actually exposed may be removed.
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

/** Error carrying the HTTP status the route should answer with. */
function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/** Log through the host logger when available; never throws (logging must not break deletion). */
function warn(host, message) {
    try {
        const logger = host?.ctx?.logger;
        if (logger?.warn) {
            logger.warn(message);
            return;
        }
        console.warn(message);
    }
    catch {
        // ignore
    }
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
 * Drop one session's projection-cache record. Preferred path is the host's
 * open `session_projcache` domain: the domain write chain durably removes the
 * record from the medium FIRST, then from host memory, so the host's
 * write-behind can never republish a stale row afterwards. Falls back to the
 * legacy best-effort direct file edit when the domain is unavailable or the
 * record was not in host memory.
 */
async function clearProjectionCache(host, home, sessionId) {
    try {
        const domain = host?.storageDomain?.get?.('session_projcache');
        if (domain) {
            const removed = await domain.table('sessions').delete(sessionId);
            if (removed) return;
        }
    }
    catch (error) {
        warn(host, `archive-manager: domain cache delete failed, falling back to file edit: ${String(error)}`);
    }
    const cachePath = join(home, 'storages', 'session_projcache.json');
    if (!existsSync(cachePath)) return;
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

/**
 * Delete ONE archived session for real:
 * 1. refuse ids not registered in the archive set (an un-archived session
 *    may be live — deleting it is never what this endpoint is for),
 * 2. remove the id from the registry archive set and from every workspace's
 *    session list,
 * 3. remove the on-disk session directory,
 * 4. drop its projection-cache record through the host domain (falling back
 *    to a best-effort file edit).
 *
 * Live host-side state (session.list rows, running agent) is intentionally
 * left alone — the file and registry layers are the durable truth, and the
 * UI re-fetches on the next reload. Deleting a session that is currently
 * running is therefore caller's responsibility.
 *
 * @param host - cordis fiber context (webServer + storageDomain services).
 * @param sessionId - id to delete, must match the archive-registry format.
 * @returns the success payload; throws {@link httpError} on invalid input or
 *   when the session is not archived.
 */
export async function deleteArchivedSession(host, sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        throw httpError(400, `invalid session id: ${sessionId}`);
    }
    const home = dshHome();
    const workspacePath = join(home, 'storages', 'workspace.json');

    // 1. Guard: the id must be registered in the archive set. A missing
    //    registry or an unknown id means "never archived" — refuse loudly
    //    rather than removing files that may belong to a live session.
    const workspace = existsSync(workspacePath) ? readJson(workspacePath) : null;
    const archived = workspace?.global?.archivedSessionIds;
    if (!Array.isArray(archived) || !archived.includes(sessionId)) {
        throw httpError(400, `session is not archived: ${sessionId}`);
    }

    // 2. Registry accounting: archive set + per-workspace session lists.
    if (workspace !== null) {
        let changed = false;
        if (archived.includes(sessionId)) {
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

    // 4. Projection-cache record (through the host domain when possible).
    await clearProjectionCache(host, home, sessionId);

    return { deleted: true };
}

/**
 * Restore ONE archived session: remove its id from the registry-global archive
 * set via the host's own workspace registry. The session keeps its workspace
 * `sessionIds` slot, so unarchiving restores its original position in the
 * main UI instantly — the host pushes `host/archived-sessions-changed` and the
 * client store un-hides it. Nothing else (no file or log mutation) is needed.
 *
 * Idempotent: an id that is no longer archived resolves as `{ restored: false }`
 * without writing, so double-clicks and stale rows never error.
 *
 * @param host - cordis fiber context carrying the workspaceRegistry service.
 * @param sessionId - id to restore; must match the archive-registry format.
 * @returns the result payload; throws {@link httpError} on invalid input.
 */
export async function restoreArchivedSession(host, sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        throw httpError(400, `invalid session id: ${sessionId}`);
    }
    const registry = host?.workspaceRegistry;
    if (!registry || typeof registry.enqueueOperation !== 'function') {
        throw new Error('workspace registry is unavailable');
    }
    let restored = false;
    await registry.enqueueOperation(async () => {
        const state = registry.requireState();
        const archived = state?.archivedSessionIds;
        if (!Array.isArray(archived) || !archived.includes(sessionId)) {
            return; // already restored — idempotent success, no write.
        }
        await registry.setState({
            ...state,
            archivedSessionIds: archived.filter((id) => id !== sessionId),
        });
        restored = true;
    });
    return { restored };
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
                    const status = typeof error.status === 'number' ? error.status : 500;
                    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }),
        host.webServer.register({
            kind: 'exact',
            path: '/dsh-archive-manager-plus/restore',
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
                    sendJson(response, 200, { ok: true, ...(await restoreArchivedSession(host, sessionId)) });
                }
                catch (error) {
                    const status = typeof error.status === 'number' ? error.status : 500;
                    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
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
                    // Success contract mirrors the list route's { ok: bool, ... }
                    // response: the browser half gates on `body.ok === true`.
                    sendJson(response, 200, { ok: true, ...(await deleteArchivedSession(host, sessionId)) });
                }
                catch (error) {
                    const status = typeof error.status === 'number' ? error.status : 500;
                    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }),
    ];
    return () => {
        for (const dispose of disposers) dispose();
    };
}