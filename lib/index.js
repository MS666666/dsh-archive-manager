/**
 * dsh-archive-manager-plus host half: mounts the archive-management HTTP routes
 * once the profile composes the webServer service.
 */
import { mountArchiveRoutes } from './routes.js';

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
    ctx.inject(['webServer', 'storageDomain', 'workspaceRegistry'], (host) => {
        host.effect(() => mountArchiveRoutes(host), 'dsh-archive-manager-plus: http routes');
    });
}