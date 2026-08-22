/**
 * dsh-archive-manager host half: mounts the archive-management HTTP routes
 * once the profile composes the webServer service.
 */
import { mountArchiveRoutes } from './routes.js';

/** Cordis plugin identity (the name the profile patch inserts). */
export const name = 'dsh-archive-manager';

/**
 * Register the plugin against the host context.
 * @param ctx - Host context that may acquire the webServer service.
 * @param config - Optional profile override from the loader (unused today).
 */
export function apply(ctx, config) {
    ctx.inject(['webServer'], (host) => {
        host.effect(() => mountArchiveRoutes(host), 'dsh-archive-manager: http routes');
    });
}