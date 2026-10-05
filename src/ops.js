/**
 * dsh-dev-workbench — 命令执行封装。
 *
 * - 快速命令（devices/connect/logcat 单次）：**异步 spawn + 超时**（绝不 spawnSync —— DSH 单线程，
 *   同步调用会把整个 harness 冻住；实测 `adb devices` 冷启动 1-3s）。
 * - 长操作（build/test/install）：后台 spawn，输出落盘 + 内存 tail，返回 opId。
 * - Windows 兼容：.cmd/.bat 统一经 cmd.exe /d /s /c 包装（Node 无法直接 spawn
 *   .bat：bare 名 ENOENT、.cmd EINVAL）；.exe 直接 spawn。
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const QUICK_TIMEOUT_MS = 60000;

/**
 * 平台正确的 (command, args)：
 * - win32 且命令为 .cmd/.bat → cmd.exe /d /c <cmd> <args...>
 * - 其余 → 原样
 *
 * 注意两个曾经踩过的坑（都会让构建工具"秒失败"）：
 * 1) 不要把 command+args 手工拼成一个大字符串再交给 cmd —— cmd 会把
 *    "C:\path\x.bat" 连同引号当成可执行文件名，报
 *    `'"C:\path\x.bat"' 不是内部或外部命令`。
 * 2) 不要加 /s —— /s 会剥掉整串命令行的首尾引号，带空格的路径会被截断成
 *    `C:\...\with` 而找不到。
 * 正确姿势：分开传 argv，由 Node 负责给含空格的参数加引号，用 cmd /d /c。
 */
export function wrapCommand(command, args = []) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return ["cmd", ["/d", "/c", command, ...args]];
  }
  return [command, args];
}

/**
 * 异步执行一次命令，超时 kill，返回 { ok, status, stdout, stderr, error }。
 *
 * ⚠️ 不要改回 spawnSync：DSH 是单线程 Node 进程，同步执行子命令会把整个 harness
 * （Web UI、SSE、流式输出）冻住。实测本机 `adb devices` 冷启动要 1-3s（adb server 首次拉起），
 * 同步版就是整站卡 3.5s（dev-workbench 状态卡片曾因此实测 3.54s 全站冻结）。
 */
export function runAsync(command, args = [], { cwd, env, timeoutMs = QUICK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return done({ ok: false, status: null, stdout: "", stderr: "", error: String(e?.message ?? e) });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
      done({ ok: false, status: null, stdout, stderr, error: `超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, status: null, stdout, stderr, error: String(e?.message ?? e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, status: code ?? null, stdout, stderr, error: null });
    });
  });
}

/** 后台长操作管理器：spawn + 落盘 + tail + opId。 */
export function createOpRunner() {
  const ops = new Map();

  function start(label, command, args = [], { cwd, env } = {}) {
    const opId = `devop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logFile = join(tmpdir(), `dsh-devworkbench-${opId}.log`);
    mkdirSync(tmpdir(), { recursive: true });
    const op = {
      id: opId,
      label,
      command,
      args,
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      exitCode: null,
      error: null,
      logFile,
      lines: [],
    };
    ops.set(opId, op);

    const [cmd, argv] = wrapCommand(command, args);
    const child = spawn(cmd, argv, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const push = (chunk) => {
      const s = chunk.toString();
      op.lines.push(s);
      // 内存只留最近 64KB，其余在 logFile
      let joined = op.lines.join("");
      if (joined.length > 65536) {
        appendFileSync(op.logFile, joined.slice(0, joined.length - 65536));
        op.lines = [joined.slice(-65536)];
      }
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => {
      op.status = "failed";
      op.error = e.message;
      op.finishedAt = Date.now();
    });
    child.on("close", (code) => {
      op.exitCode = code;
      op.status = code === 0 ? "done" : "failed";
      op.finishedAt = Date.now();
      // 关闭时把剩余内存行落盘
      try {
        appendFileSync(op.logFile, op.lines.join(""));
      } catch {
        /* noop */
      }
    });
    return opId;
  }

  function status(opId) {
    const op = ops.get(opId);
    if (!op) return null;
    return {
      id: op.id,
      label: op.label,
      status: op.status,
      exitCode: op.exitCode,
      error: op.error,
      startedAt: op.startedAt,
      finishedAt: op.finishedAt,
      tail: op.lines.join("").slice(-4000),
      logFile: op.logFile,
    };
  }

  function list() {
    return [...ops.values()].map((op) => ({
      id: op.id,
      label: op.label,
      status: op.status,
      exitCode: op.exitCode,
      startedAt: op.startedAt,
      finishedAt: op.finishedAt,
    }));
  }

  return { start, status, list };
}
