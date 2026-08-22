/**
 * dsh-archive-manager browser half: a "归档管理" settings section that lists
 * archived sessions and lets the user delete them for real.
 *
 * Client-plugin contract (see dshmarket for the reference shape):
 *   window.__ModuleLoader__.load({ id, factory }) with CJS exports
 *   { name, inject, apply }; apply receives the client-side cordis ctx with
 *   slots (slot registry) and locale services made available through inject.
 */
window.__ModuleLoader__.load({
	id: "dsh-archive-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		/** Dictionary namespace owned by this plugin. */
		const NS = "dsh-archive-manager";
		const zh = {
			nav: "归档管理",
			desc: "管理已归档的会话：归档只是从会话列表隐藏；在这里可以彻底删除（会话日志与记账一并移除）。",
			empty: "暂无已归档的会话。",
			loading: "加载中…",
			loadFailed: "加载失败，请重试。",
			workspace: "工作区",
			created: "创建时间",
			onDisk: "日志在盘",
			onDiskYes: "是",
			onDiskNo: "否",
			delete: "删除",
			deleting: "删除中…",
			confirmTitle: "确认删除会话？",
			confirmBody: "该操作会连同会话日志文件、归档标记与投影缓存一起删除，无法恢复。",
			cancel: "取消",
			confirmOk: "删除",
			deleteFailed: "删除失败。",
			none: "—"
		};
		const en = {
			nav: "Archive manager",
			desc: "Manage archived sessions: archiving only hides a session from the list; here you can delete it for real (log and accounting removed).",
			empty: "No archived sessions yet.",
			loading: "Loading…",
			loadFailed: "Failed to load. Please retry.",
			workspace: "Workspace",
			created: "Created",
			onDisk: "Log on disk",
			onDiskYes: "Yes",
			onDiskNo: "No",
			delete: "Delete",
			deleting: "Deleting…",
			confirmTitle: "Delete this session?",
			confirmBody: "This permanently removes the session log, archive marker, and projection cache. It cannot be undone.",
			cancel: "Cancel",
			confirmOk: "Delete",
			deleteFailed: "Delete failed.",
			none: "—"
		};

		/** One archived-session row with a delete button; userId-path free, purely presentational. */
		function ArchiveRow({ row, t, onDelete, busy }) {
			const created = row.createdAt != null ? new Date(row.createdAt).toLocaleString() : t("none");
			const title = row.title || row.sessionId;
			return react_jsx_runtime.jsx("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 12,
					padding: "10px 12px",
					borderBottom: "1px solid var(--dsh-border, rgba(128,128,128,.25))"
				},
				children: [
					react_jsx_runtime.jsx("div", {
						style: { flex: "1 1 auto", minWidth: 0 },
						children: [
							react_jsx_runtime.jsx("div", {
								style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								children: title
							}),
							react_jsx_runtime.jsx("div", {
								style: { fontSize: 12, opacity: 0.7, marginTop: 2, display: "flex", gap: 12, flexWrap: "wrap" },
								children: [
									react_jsx_runtime.jsx("span", { children: t("created") + ": " + created }),
									react_jsx_runtime.jsx("span", { children: t("onDisk") + ": " + (row.onDisk ? t("onDiskYes") : t("onDiskNo")) })
								]
							})
						]
					}),
					react_jsx_runtime.jsx("button", {
						type: "button",
						disabled: busy,
						onClick: () => onDelete(row.sessionId),
						style: {
							flex: "0 0 auto",
							padding: "6px 12px",
							borderRadius: 6,
							border: "1px solid rgba(220,80,80,.5)",
							background: "rgba(220,80,80,.12)",
							color: "var(--dsh-danger, #dc5050)",
							cursor: busy ? "default" : "pointer",
							opacity: busy ? 0.5 : 1
						},
						children: busy ? t("deleting") : t("delete")
					})
				]
			});
		}

		/** The settings-section body: fetch archived list, render rows with delete. */
		function ArchiveManagerSection({ t }) {
			const [rows, setRows] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busyId, setBusyId] = react.useState(null);

			const load = react.useCallback(() => {
				setError(null);
				setRows(null);
				fetch("/dsh-archive-manager/list", { cache: "no-store" })
					.then((res) => res.json())
					.then((body) => {
						if (body && body.ok === true) {
							setRows(body.sessions ?? []);
						}
						else {
							setError((body && body.error) || t("loadFailed"));
						}
					})
					.catch(() => setError(t("loadFailed")));
			}, [t]);

			react.useEffect(() => {
				load();
			}, [load]);

			const onDelete = react.useCallback((sessionId) => {
				const confirmed = globalThis.confirm(t("confirmTitle") + "\n\n" + t("confirmBody"));
				if (!confirmed) return;
				setBusyId(sessionId);
				fetch("/dsh-archive-manager/delete", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				})
					.then((res) => res.json())
					.then((body) => {
						if (body && body.ok === true) {
							load();
						}
						else {
							setError((body && body.error) || t("deleteFailed"));
							setBusyId(null);
						}
					})
					.catch(() => {
						setError(t("deleteFailed"));
						setBusyId(null);
					});
			}, [t, load]);

			let body;
			if (error !== null) {
				body = react_jsx_runtime.jsx("div", { style: { padding: 12 }, children: error });
			}
			else if (rows === null) {
				body = react_jsx_runtime.jsx("div", { style: { padding: 12, opacity: 0.7 }, children: t("loading") });
			}
			else if (rows.length === 0) {
				body = react_jsx_runtime.jsx("div", { style: { padding: 12, opacity: 0.7 }, children: t("empty") });
			}
			else {
				body = react_jsx_runtime.jsx("div", { style: { border: "1px solid var(--dsh-border, rgba(128,128,128,.25))", borderRadius: 8, marginTop: 4 }, children: rows.map((row) => react_jsx_runtime.jsx(ArchiveRow, {
					row,
					t,
					busy: busyId === row.sessionId,
					onDelete
				}, row.sessionId)) });
			}

			return react_jsx_runtime.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 8, padding: "4px 0" },
				children: [
					react_jsx_runtime.jsx("div", { style: { fontSize: 13, opacity: 0.8, padding: "0 12px" }, children: t("desc") }),
					body
				]
			});
		}

		const name = "dsh-archive-manager";
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale"
		];
		/**
		 * Register the archive-management section once the settings
		 * declarations are on the ledger.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-archive-manager: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "archive-manager",
				order: 60,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ t })
			}, ArchiveManagerSection));
		}
		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});