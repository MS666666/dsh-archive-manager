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
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { releaseArchivedSession } from './session-lifecycle.js';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

/** Only ids shaped like `session-<hex/dash>` are ever touched by delete. */
const SESSION_ID_RE = /^session-[0-9a-fA-F-]+$/;

/**
 * Resolve the harness home the same way the host does: `$DSH_HOME` when it is
 * set and non-blank, otherwise `~/.dsh`.
 *
 * Reading `process.env.DSH_HOME` alone is wrong here: the host process is
 * usually started without that variable (the harness injects it only into the
 * tool subprocesses it spawns), so a bare read made this whole settings page
 * fail with "DSH_HOME is not set" even though the default home existed. An
 * empty or whitespace-only value is treated as unset, mirroring
 * `resolveDshHome`, so a blank override never resolves to the cwd.
 *
 * @returns the absolute harness home path.
 */
function dshHome(host) {
    const root = host?.sessionPersistence?.root;
    if (typeof root === 'string' && /[\\/]sessions[\\/]?$/.test(root)) return dirname(resolve(root));
    const configured = process.env.DSH_HOME;
    if (configured !== undefined && configured.trim().length > 0) return resolve(configured === '~' ? homedir() : /^~[\\/]/.test(configured) ? join(homedir(), configured.slice(2)) : configured);
    return join(homedir(), '.dsh');
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const deletingSessionIds = new Set();
export function isSessionDeletionBlocked(host, id) {
    return deletingSessionIds.has(id) || deletedSessionIds(dshHome(host)).includes(id);
}

/** Permanent deletion receipts are plugin-owned, independent of host snapshots. */
function deletedSessionIds(home) {
    const path = join(home, 'storages', 'archive-manager-deleted.json');
    if (!existsSync(path)) return [];
    const ids = readJson(path).sessionIds;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !SESSION_ID_RE.test(id))) {
        throw new Error('Invalid archive-manager deletion receipts');
    }
    return ids;
}

function rememberDeletion(home, sessionId) {
    const path = join(home, 'storages', 'archive-manager-deleted.json');
    const ids = [...new Set([...deletedSessionIds(home), sessionId])];
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeJson(temporary, { version: 1, sessionIds: ids });
    renameSync(temporary, path);
}

function forgetSessionIndex(registry, id) {
    for (const key of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) {
        registry[key]?.delete?.(id);
    }
}

/** Repair a stale host snapshot without touching any session log files. */
export async function reconcileDeletedSessions(host) {
    const registry = host?.workspaceRegistry;
    const deleted = new Set(deletedSessionIds(dshHome(host)));
    if (!deleted.size || !registry) return;
    await registry.enqueueOperation(async () => {
        for (const workspace of registry.list()) {
            // The public getter filters stale/missing ids. Mutate the durable
            // table through the entity even when that getter hides the id.
            for (const id of deleted) await workspace.detachSession(id);
        }
        const state = registry.requireState();
        const archived = state.archivedSessionIds.filter(id => !deleted.has(id));
        const pinned = (state.pinnedSessionIds ?? []).filter(id => !deleted.has(id));
        if (archived.length !== state.archivedSessionIds.length || pinned.length !== (state.pinnedSessionIds ?? []).length) {
            await registry.setState({ ...state, archivedSessionIds: archived, pinnedSessionIds: pinned });
        }
        for (const id of deleted) {
            // A failed native reload can checkpoint before agent/created rejects
            // publication. Receipts must also repair those late cache writes.
            await releaseArchivedSession(host, id);
            await clearProjectionCache(host, dshHome(host), id);
            forgetSessionIndex(registry, id);
        }
    });
}

/** Error carrying the HTTP status the route should answer with. */
function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
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
function sessionDirOnDisk(home, sessionId, host) {
    const sessionsRoot = host?.sessionPersistence?.root ?? join(home, 'sessions');
    if (!existsSync(sessionsRoot)) return null;
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(sessionsRoot, entry.name, sessionId);
        if (existsSync(dir)) {
            if (lstatSync(dir).isSymbolicLink()) throw httpError(409, 'Refusing a linked session directory');
            return dir;
        }
    }
    return null;
}

/**
 * Cache summaries from the projection cache, keyed by session id.
 *
 * The projection cache moved from one monolithic `session_projcache.json` to a
 * per-session directory (`session_projcache/sessions/<id>.json`); on an upgraded
 * install the monolithic file is a stale leftover holding only the sessions
 * that existed before the migration, so reading it alone reported `title: null`
 * for every archived session. Both layouts are merged here so either one alone
 * is enough to resolve a title.
 *
 * @param home - resolved harness home.
 * @returns map of session id to `{ title, createdAt }` (fields may be absent).
 */
function readTitleCache(home) {
    // Legacy first, per-session records overlay it: on a mixed install the
    // newer per-session value wins, and a session present only in either
    // layout still resolves.
    const out = readLegacyTitleCache(home);
    for (const [id, summary] of Object.entries(readPerSessionCache(home))) {
        out[id] = { ...out[id], ...summary };
    }
    return out;
}

/** Per-session projection-cache records: `storages/session_projcache/sessions/<id>.json`. */
function readPerSessionCache(home) {
    const dir = join(home, 'storages', 'session_projcache', 'sessions');
    if (!existsSync(dir)) return {};
    const out = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -'.json'.length);
        try {
            const record = readJson(join(dir, entry.name))?.record;
            const title = record?.rows?.title?.val;
            const createdAt = record?.identity?.createdAt;
            const summary = {};
            if (typeof title === 'string' && title.trim().length > 0) summary.title = title;
            if (typeof createdAt === 'number') summary.createdAt = createdAt;
            if (Object.keys(summary).length > 0) out[id] = summary;
        }
        catch {
            // A single unreadable record must not hide the other sessions.
        }
    }
    return out;
}

/** Legacy monolithic `storages/session_projcache.json` (pre-migration layout). */
function readLegacyTitleCache(home) {
    const path = join(home, 'storages', 'session_projcache.json');
    if (!existsSync(path)) return {};
    try {
        const cache = readJson(path);
        const out = {};
        for (const [id, record] of Object.entries(cache.tables?.sessions ?? {})) {
            const title = record.rows?.title?.val;
            const createdAt = record.identity?.createdAt;
            const summary = {};
            if (typeof title === 'string' && title.trim().length > 0) summary.title = title;
            if (typeof createdAt === 'number') summary.createdAt = createdAt;
            out[id] = summary;
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
export function listArchivedSessions(host) {
    const home = dshHome(host);
    const workspacePath = join(home, 'storages', 'workspace.json');
    const workspace = !host?.workspaceRegistry && existsSync(workspacePath) ? readJson(workspacePath) : null;
    const archived = host?.workspaceRegistry?.archivedSessionIds ?? workspace?.global?.archivedSessionIds ?? [];
    const titles = readTitleCache(home);
    const table = host?.storageDomain?.get?.('session_projcache')?.table('sessions');
    for (const id of archived) {
        const record = table?.get(id);
        if (record) {
            const title = record.rows?.title?.val;
            const createdAt = record.identity?.createdAt;
            titles[id] = { ...titles[id],
                ...(typeof title === 'string' && title.trim() ? { title } : {}),
                ...(typeof createdAt === 'number' ? { createdAt } : {}),
            };
        }
    }
    const deleted = new Set(deletedSessionIds(home));
    return archived.filter(id => !deleted.has(id)).map((sessionId) => ({
        sessionId,
        title: titles[sessionId]?.title ?? null,
        createdAt: titles[sessionId]?.createdAt ?? null,
        onDisk: sessionDirOnDisk(home, sessionId, host) !== null,
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
    const domain = host?.storageDomain?.get?.('session_projcache');
    if (domain) await domain.table('sessions').delete(sessionId);
    const recordPath = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    rmSync(recordPath, { force: true });
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
 * 2. clear projection caches and detach workspace accounting through live services,
 * 3. remove the on-disk session directory,
 * 4. clear the live archive marker last, so failures can be retried.
 *
 * The version-aware lifecycle adapter releases loaded agents, flushes their writer,
 * and detaches the session before deletion; the native session feed is notified.
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
    const home = dshHome(host);
    const registry = host?.workspaceRegistry;
    if (typeof registry?.enqueueOperation !== 'function') {
        throw httpError(503, 'workspace registry is unavailable');
    }
    await registry.enqueueOperation(async () => {
        const state = registry.requireState();
        if (!state.archivedSessionIds.includes(sessionId)) {
            throw httpError(400, `session is not archived: ${sessionId}`);
        }
        deletingSessionIds.add(sessionId);
        try {
            await releaseArchivedSession(host, sessionId);
            const dir = sessionDirOnDisk(home, sessionId, host);
            await clearProjectionCache(host, home, sessionId);
            for (const workspace of registry.list()) {
                await workspace.detachSession(sessionId);
            }
            if (dir !== null) rmSync(dir, { recursive: true, force: true });
            // Clear the archive marker last so a failed cleanup can be retried.
            await registry.setState({
                ...state,
                archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
                pinnedSessionIds: (state.pinnedSessionIds ?? []).filter((id) => id !== sessionId),
            });
            rememberDeletion(home, sessionId);
            forgetSessionIndex(registry, sessionId);
            // Cold sessions have no session/disposed event. Explicitly publish
            // the same removal notification consumed by the native session feed.
            try { host.emit?.('api-session/removed', sessionId); }
            catch (error) { console.warn('archive-manager: sidebar notification failed:', error.message); }
        } finally { deletingSessionIds.delete(sessionId); }
    });

    return { deleted: true };
}

/** Explicitly confirmed menu action: archive first, then use the same deletion path. */
export async function deleteSessionFromMenu(host, sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        throw httpError(400, 'invalid session id');
    }
    if (deletedSessionIds(dshHome(host)).includes(sessionId)) return { deleted: true };
    if (typeof host.workspaceRegistry?.archiveSession !== 'function') {
        throw httpError(503, '当前宿主不支持归档会话。');
    }
    await host.workspaceRegistry.archiveSession(sessionId, { stopActivity: true });
    return deleteArchivedSession(host, sessionId);
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
    if (typeof registry.unarchiveSession === 'function') {
        const restored = registry.archivedSessionIds.includes(sessionId);
        await registry.unarchiveSession(sessionId);
        return { restored };
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
            handler: async (request, response) => {
                if (request.method !== 'GET') {
                    response.writeHead(405, { allow: 'GET' });
                    response.end();
                    return;
                }
                try {
                    await reconcileDeletedSessions(host);
                    sendJson(response, 200, { ok: true, sessions: listArchivedSessions(host) });
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
                    sendJson(response, 200, { ok: true, ...(await (body.archiveFirst === true ? deleteSessionFromMenu(host, sessionId) : deleteArchivedSession(host, sessionId))) });
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