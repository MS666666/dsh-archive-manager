/**
 * dsh-archive-manager-plus host half: mounts the archive-management HTTP routes
 * once the profile composes the webServer service.
 */
import { mountArchiveRoutes, reconcileDeletedSessions, isSessionDeletionBlocked } from './routes.js';

/** Cordis plugin identity (the name the profile patch inserts). */
export const name = 'dsh-archive-manager-plus';

/**
 * Register the plugin against the host context.
 * @param ctx - Host context that may acquire the webServer service.
 * @param config - Optional profile override from the loader (unused today).
 */
export function apply(ctx, config) {
    // storageDomain lets the delete route drop projection-cache records through
    // the host's own domain write chain (durable + in-memory); workspaceRegistry
    // lets the restore route mutate the live archive set so the main UI
    // un-hides the session in real time.
    ctx.inject(['webServer', 'storageDomain', 'workspaceRegistry', 'sessionPersistence', 'sessions', 'agents'], (host) => {
        host.effect(() => mountArchiveRoutes(host), 'dsh-archive-manager-plus: http routes');
        host.on('agent/created', ({ agent }) => {
            if (isSessionDeletionBlocked(host, agent.id)) {
                throw new Error('该会话已删除或正在删除，不能重新加载。');
            }
        });
        const repair = () => reconcileDeletedSessions(host).catch(error => {
            console.warn('archive-manager: deletion reconciliation failed:', error.message);
        });
        // Do not await from a domain notification: the current domain write
        // must finish before the registry queue can make its repair write.
        host.on('domain/changed', change => {
            if (change.domain === 'workspace'
                || (change.domain === 'session_projcache' && change.operation !== 'deleted'
                    && isSessionDeletionBlocked(host, change.key))) void repair();
        });
        void repair();
    });
}