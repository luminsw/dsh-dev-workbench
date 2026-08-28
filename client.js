/**
 * dsh-dev-workbench 客户端模块（DSH Web UI 侧）。
 *
 * 在 DSH 设置 → 插件页注册一张「三语种开发工作台」卡片：
 *  - Android / HarmonyOS 设备状态（10s 自动刷新）
 *  - 各项目（kotlin / baihua / mdyjCloud / arkts）一键构建按钮
 *  - 后台操作（build/test/install）列表与状态
 * 数据源：host 侧 /dsh-dev-workbench/status（仅 127.0.0.1 webServer、免鉴权、只读）；
 * 构建按钮走 /dsh-dev-workbench/ui-action（同源免 token）。
 */
window.__ModuleLoader__.load({
  id: "dsh-dev-workbench",
  factory(require) {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const STATUS_URL = "/dsh-dev-workbench/status";
    const ACTION_URL = "/dsh-dev-workbench/ui-action";

    const PROJECTS = [
      { key: "kotlin", label: "Kotlin (Android)" },
      { key: "baihua", label: "C# (百花)" },
      { key: "mdyjCloud", label: "C# (花阁云)" },
      { key: "arkts", label: "ArkTS (鸿蒙)" },
    ];

    const fmtTime = (t) => {
      if (!t) return "";
      const d = new Date(t);
      return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
    };

    const style = {
      card: { display: "flex", flexDirection: "column", gap: 12, padding: "12px 0" },
      row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
      btn: {
        padding: "4px 12px", borderRadius: 6, border: "1px solid var(--dsh-border, #444)",
        background: "var(--dsh-surface-2, #222)", color: "inherit", cursor: "pointer", fontSize: 12,
      },
      mono: { fontFamily: "monospace", fontSize: 12, color: "var(--dsh-text-secondary, #aaa)" },
      ok: { color: "#4caf50" },
      err: { color: "#f44336" },
      sectionTitle: { fontSize: 12, fontWeight: 600, opacity: 0.8, margin: "8px 0 4px" },
    };

    function DevWorkbenchCard() {
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);
      const [msg, setMsg] = useState(null); // { ok, text }

      const load = useCallback(async () => {
        try {
          const res = await fetch(STATUS_URL, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const json = await res.json();
          setData(json);
          setErr(null);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      }, []);

      useEffect(() => {
        load();
        const timer = setInterval(load, 10000);
        return () => clearInterval(timer);
      }, [load]);

      const triggerBuild = async (project) => {
        try {
          const res = await fetch(`${ACTION_URL}?action=build&project=${project}`, { cache: "no-store" });
          const j = await res.json().catch(() => null);
          if (!j || !j.ok) throw new Error((j && j.error) || "HTTP " + res.status);
          setMsg({ ok: true, text: `已开始构建 ${project}（opId=${j.opId}）` });
          setTimeout(load, 1500);
        } catch (e) {
          setMsg({ ok: false, text: `构建启动失败：${e instanceof Error ? e.message : String(e)}` });
        }
      };

      const devices = data?.devices || {};
      const android = devices.android || [];
      const harmony = devices.harmony || [];
      const ops = data?.ops || [];

      return React.createElement(
        "div",
        { style: style.card },
        err &&
          React.createElement("div", { style: style.err }, `工作台状态不可用：${err}（DSH 重启后生效）`),
        React.createElement(
          "div",
          { style: style.sectionTitle },
          "设备",
        ),
        React.createElement(
          "div",
          { style: style.row },
          React.createElement("span", { style: style.mono }, `Android (adb): ${android.length ? android.map((d) => d.serial).join(", ") : "无"}`),
          React.createElement("span", { style: style.mono }, `| HarmonyOS (hdc): ${harmony.length ? harmony.map((d) => d.serial).join(", ") : "无"}`),
        ),
        React.createElement("div", { style: style.sectionTitle }, "一键构建（后台执行，结果见 dev_build_status）"),
        React.createElement(
          "div",
          { style: style.row },
          PROJECTS.map((p) =>
            React.createElement(
              "button",
              { key: p.key, style: style.btn, onClick: () => triggerBuild(p.key), title: `构建 ${p.label}` },
              p.label,
            ),
          ),
        ),
        ops.length > 0 &&
          React.createElement(
            "div",
            {},
            React.createElement("div", { style: style.sectionTitle }, "最近操作"),
            ops
              .slice(-6)
              .reverse()
              .map((op) =>
                React.createElement(
                  "div",
                  { key: op.id, style: style.row },
                  React.createElement("span", { style: style.mono }, `${op.label}`),
                  React.createElement(
                    "span",
                    {
                      style: op.status === "done" ? style.ok : op.status === "failed" ? style.err : style.mono,
                    },
                    `${op.status}${op.exitCode != null ? ` (exit ${op.exitCode})` : ""} ${fmtTime(op.startedAt)}`,
                  ),
                ),
              ),
          ),
        msg &&
          React.createElement(
            "div",
            { style: msg.ok ? style.ok : style.err },
            msg.text,
          ),
      );
    }

    return {
      name: "dsh-dev-workbench-client",
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.plugin.item", function* () {
          yield ctx.slots.register(
            {
              name: "settings.plugin.item",
              key: "devWorkbench",
              locale: "settings.devWorkbench",
            },
            DevWorkbenchCard,
          );
        });
      },
    };
  },
});
