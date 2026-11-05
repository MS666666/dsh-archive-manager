/** 0.2.1-rc.5 / 0.2.2-rc.1 adapter: mirror the factory teardown order before removing an artifact.
 * These are version-specific implementation members; feature-check before changing anything.
 */
function busy(message) {
    return Object.assign(new Error(message), { status: 409 });
}

export async function releaseArchivedSession(host, id) {
    const agent = host.agents?.get?.(id);
    const session = host.sessions?.get?.(id);
    const agents = host.agents;
    const sessions = host.sessions;
    const tracker = host.sessionPersistence?.tracker;
    const writers = tracker?.writers;
    const writer = writers?.get(id);
    const agentEntry = agents?.store?.get(id);
    const sessionEntry = sessions?.store?.get(id);
    if ((agent && (!agent.scope?.dispose || !agent.cancel || !agent.whenIdle
        || agentEntry?.agent !== agent || typeof agents.detachEntered !== 'function'))
        || (session && (sessionEntry?.session !== session || typeof sessions.detachEntered !== 'function'))
        || (writers?.has(id) && !writer?.close)) {
        throw busy('会话正在加载或当前宿主不支持释放，请稍后重试。');
    }
    if (agentEntry?.announcing || sessionEntry?.announcing || sessionEntry?.appending
        || (sessionEntry?.announcement !== undefined && sessionEntry.announcement !== 'complete')) {
        throw busy('会话正在保存，请稍后重试删除。');
    }
    if (agent) {
        agent.cancel({ kind: 'disposed' });
        await agent.whenIdle();
        await agent.scope.dispose();
    }
    // close() drains pending events, flushes the log and releases the lease.
    // A failed close prevents both detachment and physical file deletion.
    if (writer) await writer.close();
    if (agentEntry) agents.detachEntered(agentEntry);
    if (sessionEntry) sessions.detachEntered(sessionEntry);
    if (agents?.get?.(id) || sessions?.get?.(id) || writers?.has(id)) {
        throw busy('会话资源尚未完全释放，请稍后重试删除。');
    }
    host.sessionPersistence?.coldLogMemo?.delete(id);
}
