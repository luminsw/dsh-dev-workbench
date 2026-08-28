/**
 * dsh-dev-workbench — 三语种（C#/.NET、Kotlin/Android、ArkTS/HarmonyOS）开发工作台。
 *
 * Host 侧提供：
 *  - dev_* 工具：构建/测试/安装/设备/日志（dotnet、gradlew、hvigorw、adb、hdc）
 *  - webServer 状态端点 /dsh-dev-workbench/status（供 Client 设置页卡片拉取，只读）
 *
 * 安装到 DSH web profile（cordis.patch.yml insert 或 bundle 层）即可加载。
 * 宿主机操作（构建/安装/测试）会以当前用户权限执行，工具描述中已注明需先经用户确认。
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { runQuick, createOpRunner } from "./ops.js";

export const name = "dsh-dev-workbench";

export const inject = ["tools"];

export const Config = z.object({
  /** 各项目根目录；省略时按 ~/src/<name> 自动探测。 */
  projects: z
    .object({
      kotlin: z.string().default(""),
      baihua: z.string().default(""),
      mdyjCloud: z.string().default(""),
      arkts: z.string().default(""),
    })
    .default({}),
  /** adb 可执行文件（默认自动探测 PATH / Android SDK 常见位置）。 */
  adbPath: z.string().default(""),
  /** hdc 可执行文件（默认自动探测 PATH / DevEco 常见位置）。 */
  hdcPath: z.string().default(""),
  /** Kotlin/Gradle 构建所需 JDK21 目录（默认 Android Studio 自带 jbr）。 */
  javaHome: z.string().default(""),
  /** DevEco Studio 根目录（arkts 构建用，默认 C:\\Program Files\\Huawei\\DevEco Studio）。 */
  devecoHome: z.string().default(""),
});

const HOME = homedir();

function probePaths(config) {
  const project = (name) => {
    const p = config.projects?.[name] || join(HOME, "src", name);
    return existsSync(p) ? p : p;
  };
  const adb =
    config.adbPath ||
    (findOnPath("adb") ? "adb" : join(HOME, "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"));
  const hdc =
    config.hdcPath ||
    (findOnPath("hdc")
      ? "hdc"
      : join("C:\\Program Files\\Huawei\\DevEco Studio", "sdk", "default", "openharmony", "toolchains", "hdc.exe"));
  const javaHome = config.javaHome || "C:\\Program Files\\Android\\Android Studio\\jbr";
  const devecoHome = config.devecoHome || "C:\\Program Files\\Huawei\\DevEco Studio";
  return {
    projects: {
      kotlin: project("kotlin"),
      baihua: project("baihua"),
      mdyjCloud: project("mdyj-cloud"),
      arkts: project("arkts"),
    },
    adb,
    hdc,
    javaHome,
    devecoHome,
  };
}

function findOnPath(command) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const dirs = (process.env.PATH || "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const ANDROID_PROJECTS = ["kotlin"];
const DOTNET_PROJECTS = ["baihua", "mdyjCloud"];
const ARKTS_PROJECTS = ["arkts"];
const ALL_PROJECTS = [...ANDROID_PROJECTS, ...DOTNET_PROJECTS, ...ARKTS_PROJECTS];

export function apply(ctx) {
  const cfg = () => ctx.config;
  const paths = () => probePaths(cfg());
  const ops = createOpRunner();

  // ---------- 命令构造 ----------
  function buildCommand(project, target, sub) {
    const p = paths();
    if (project === "kotlin") {
      const gradlew = join(p.projects.kotlin, "gradlew.bat");
      const task =
        target === "install" ? ":app:installDebug" : target === "test" ? ":app:testDebugUnitTest" : ":app:assembleDebug";
      return {
        command: gradlew,
        args: [task],
        cwd: p.projects.kotlin,
        env: { ...process.env, JAVA_HOME: p.javaHome },
        label: `gradle ${task}`,
      };
    }
    if (project === "arkts") {
      const hvigorw = join(p.devecoHome, "tools", "hvigor", "bin", "hvigorw.bat");
      return {
        command: hvigorw,
        args: ["assembleApp"],
        cwd: p.projects.arkts,
        env: { ...process.env, DEVECO_SDK_HOME: join(p.devecoHome, "sdk"), NODE_HOME: join(p.devecoHome, "tools", "node") },
        label: "hvigorw assembleApp",
      };
    }
    if (DOTNET_PROJECTS.includes(project)) {
      const root = p.projects[project];
      const verb = target === "test" ? "test" : "build";
      const args = sub ? [verb, String(sub)] : [verb];
      return {
        command: "dotnet",
        args,
        cwd: root,
        env: { ...process.env },
        label: `dotnet ${verb}${sub ? ` ${sub}` : ""}`,
      };
    }
    return null;
  }

  // ---------- 设备与日志 ----------
  function adbDevices(p) {
    const r = runQuick(p.adb, ["devices"], { timeoutMs: 10000 });
    if (!r.ok) return { ok: false, error: r.error || r.stderr || `adb devices 失败（status ${r.status}）` };
    const lines = r.stdout.split(/\r?\n/).filter(Boolean);
    const devices = lines
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((a) => a.length >= 2 && a[1] !== "unauthorized")
      .map((a) => ({ serial: a[0], state: a[1] }));
    return { ok: true, devices };
  }

  function hdcDevices(p) {
    const r = runQuick(p.hdc, ["list", "targets"], { timeoutMs: 10000 });
    if (!r.ok) return { ok: false, error: r.error || r.stderr || `hdc list targets 失败（status ${r.status}）` };
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim());
    return { ok: true, devices: lines.map((l) => ({ serial: l.trim() })) };
  }

  // ---------- 工具注册 ----------
  ctx.tools.register(
    defineTool({
      name: "dev_devices",
      description:
        "列出 Android（adb devices）与 HarmonyOS（hdc list targets）设备。只读。若无线调试端口变化导致无设备，用 dev_connect_adb 重新连接。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() {
        const p = paths();
        const lines = ["=== Android (adb) ==="];
        const a = adbDevices(p);
        if (a.ok) lines.push(...(a.devices.length ? a.devices.map((d) => `  ${d.serial}  ${d.state}`) : ["  （无设备）"]));
        else lines.push(`  ❌ ${a.error}`);
        lines.push("", "=== HarmonyOS (hdc) ===");
        const h = hdcDevices(p);
        if (h.ok) lines.push(...(h.devices.length ? h.devices.map((d) => `  ${d.serial}`) : ["  （无设备）"]));
        else lines.push(`  ❌ ${h.error}`);
        return lines.join("\n");
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "dev_connect_adb",
      description:
        "连接 Android 无线调试设备（adb connect <ip:port>）。端口随设备重新开启无线调试而变化，连接失败时先在手机开发者选项→无线调试查看当前端口。宿主机操作。",
      parameters: {
        address: { type: "string", required: true, description: "无线调试地址，如 192.168.3.6:39261" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute(args) {
        const p = paths();
        const r = runQuick(p.adb, ["connect", String(args.address)], { timeoutMs: 20000 });
        return r.ok ? `✅ ${r.stdout.trim() || "已连接"}` : `❌ 连接失败：${r.error || r.stderr || r.stdout}`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "dev_logcat",
      description:
        "查看设备日志：Android 用 adb logcat（可带过滤串），HarmonyOS 用 hilog。参数 platform 为 android 或 harmony；filter 为日志过滤关键词（如 DeepSeekScreen / AndroidRuntime）。只读。",
      parameters: {
        platform: { type: "string", enum: ["android", "harmony"], required: true, description: "android（adb logcat）或 harmony（hilog）" },
        filter: { type: "string", description: "过滤关键词（可多个，如 'AndroidRuntime:E' 或 'gatt'）" },
        lines: { type: "integer", description: "最近行数（默认 200）" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute(args) {
        const p = paths();
        const n = Number(args.lines) || 200;
        if (args.platform === "android") {
          const filter = args.filter ? [String(args.filter)] : [];
          const r = runQuick(p.adb, ["logcat", "-d", "-t", String(n), ...filter], { timeoutMs: 20000 });
          return r.ok ? (r.stdout || "(空)") : `❌ ${r.error || r.stderr || "logcat 失败"}`;
        }
        const filterArgs = args.filter ? ["-x", String(args.filter)] : [];
        const r = runQuick(p.hdc, ["hilog", "-z", String(n), ...filterArgs], { timeoutMs: 20000 });
        return r.ok ? (r.stdout || "(空)") : `❌ ${r.error || r.stderr || "hilog 失败"}`;
      },
    }),
  );

  // 构建 / 测试 / 安装（长操作，后台执行）
  function registerLongTool(tool) {
    ctx.tools.register(
      defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute(args) {
          const project = String(args.project);
          if (!ALL_PROJECTS.includes(project)) {
            return `未知项目 ${project}，可选：${ALL_PROJECTS.join(" / ")}`;
          }
          const cmd = buildCommand(project, tool.target, args.sub ? String(args.sub) : "");
          if (!cmd) return `项目 ${project} 不支持该操作`;
          const opId = ops.start(cmd.label, cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env });
          return `已开始${cmd.label}（opId=${opId}，项目 ${project}）。用 dev_build_status 查询进度。`;
        },
      }),
    );
  }

  registerLongTool({
    name: "dev_build",
    target: "build",
    description:
      "构建指定项目（宿主机操作，耗时数分钟，后台执行，返回 opId 后用 dev_build_status 查询）：kotlin→gradlew :app:assembleDebug（自动 JAVA_HOME=JDK21）；baihua/mdyjCloud→dotnet build（仓库无 sln 时需在 sub 指定子路径，如 services/Baihua.Family 或 libs/MobileContract）；arkts→DevEco hvigorw assembleApp。执行前请先向用户确认。",
    parameters: {
      project: { type: "string", enum: ALL_PROJECTS, required: true, description: "kotlin / baihua / mdyjCloud / arkts" },
      sub: { type: "string", description: "（baihua/mdyjCloud 用）子路径，如 services/Baihua.Family" },
    },
  });

  registerLongTool({
    name: "dev_test",
    target: "test",
    description:
      "运行指定项目测试（宿主机操作，后台执行）：kotlin→gradlew :app:testDebugUnitTest；baihua/mdyjCloud→dotnet test（sub 指定子路径）；arkts 暂不支持命令行测试（用 DevEco）。执行前请先向用户确认。",
    parameters: {
      project: { type: "string", enum: ALL_PROJECTS, required: true, description: "kotlin / baihua / mdyjCloud / arkts" },
      sub: { type: "string", description: "（baihua/mdyjCloud 用）子路径，如 tests/MobileGateway.Tests" },
    },
  });

  ctx.tools.register(
    defineTool({
      name: "dev_install",
      description:
        "把构建产物安装到真机（宿主机操作，后台执行）：kotlin→adb install -r app-debug.apk（需先 dev_build 或 install 目标）；arkts→hdc install -r entry-default-signed.hap（需先 dev_build）。签名不一致时需先卸载旧包。执行前请先向用户确认。",
      parameters: { project: { type: "string", enum: ["kotlin", "arkts"], required: true, description: "kotlin 或 arkts" } },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute(args) {
        const p = paths();
        if (args.project === "kotlin") {
          const apk = join(p.projects.kotlin, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
          if (!existsSync(apk)) return `❌ 未找到 APK：${apk}。请先执行 dev_build 或 dev_build(project=kotlin, install)。`;
          const opId = ops.start("adb install -r", p.adb, ["install", "-r", apk], { cwd: p.projects.kotlin, env: process.env });
          return `已开始安装到 Android（opId=${opId}）。用 dev_build_status 查询。`;
        }
        const hap = join(p.projects.arkts, "entry", "build", "default", "outputs", "default", "entry-default-signed.hap");
        if (!existsSync(hap)) return `❌ 未找到 HAP：${hap}。请先执行 dev_build(project=arkts)。`;
        const opId = ops.start("hdc install -r", p.hdc, ["install", "-r", hap], { cwd: p.projects.arkts, env: process.env });
        return `已开始安装到 HarmonyOS（opId=${opId}）。用 dev_build_status 查询。`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "dev_build_status",
      description: "查询 dev_build / dev_test / dev_install 后台操作的进度与最近输出。参数 opId 来自对应工具的返回值。",
      parameters: { opId: { type: "string", required: true, description: "操作 ID，如 devop-..." } },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute(args) {
        const op = ops.status(String(args.opId));
        if (!op) return "未找到该操作（可能 DSH 已重启，操作记录不持久）。";
        const head = `[${op.status}] ${op.label}${op.exitCode != null ? `（exit ${op.exitCode}）` : ""}`;
        return `${head}\n${op.tail || "(无输出)"}`;
      },
    }),
  );

  // ---------- 状态端点（Client 卡片数据源，仅本机回环，只读） ----------
  const webServer = ctx.get("webServer");
  if (webServer) {
    const json = (res, code, body) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: "exact",
        path: "/dsh-dev-workbench/status",
        handler: (_req, res) => {
          const p = paths();
          const a = adbDevices(p);
          const h = hdcDevices(p);
          json(res, 200, {
            ok: true,
            devices: {
              android: a.ok ? a.devices : [{ error: a.error }],
              harmony: h.ok ? h.devices : [{ error: h.error }],
            },
            ops: ops.list(),
            projects: p.projects,
          });
        },
      });
      return dispose;
    }, "dsh-dev-workbench status endpoint");

    // UI 操作（卡片按钮用，同源免 token，仅本机回环）：action=build 触发后台构建
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: "exact",
        path: "/dsh-dev-workbench/ui-action",
        handler: (req, res) => {
          const url = new URL(req.url, "http://127.0.0.1");
          const action = url.searchParams.get("action");
          const project = url.searchParams.get("project");
          if (action === "build" && project && ALL_PROJECTS.includes(project)) {
            const cmd = buildCommand(project, "build");
            const opId = cmd ? ops.start(cmd.label, cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }) : null;
            json(res, 200, { ok: !!opId, opId });
            return;
          }
          json(res, 400, { ok: false, error: "unknown action or project" });
        },
      });
      return dispose;
    }, "dsh-dev-workbench ui-action endpoint");
  }

  return { paths: paths() };
}
