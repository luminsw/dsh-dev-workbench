/**
 * dsh-dev-workbench — 命令执行封装。
 *
 * - 快速命令（devices/connect/logcat 单次）：spawnSync + 超时，同步返回。
 * - 长操作（build/test/install）：后台 spawn，输出落盘 + 内存 tail，返回 opId。
 * - Windows 兼容：.cmd/.bat 统一经 cmd.exe /d /s /c 包装（Node 无法直接 spawn
 *   .bat：bare 名 ENOENT、.cmd EINVAL）；.exe 直接 spawn。
 */
import { spawn, spawnSync } from "node:child_process";
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

/** 同步执行一次命令，超时截断，返回 { ok, status, stdout, stderr, error }。 */
export function runQuick(command, args = [], { cwd, env, timeoutMs = QUICK_TIMEOUT_MS } = {}) {
  try {
    const r = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = (r.stdout || "").toString();
    const stderr = (r.stderr || "").toString();
    if (r.error) return { ok: false, status: null, stdout, stderr, error: r.error.message };
    return { ok: r.status === 0, status: r.status, stdout, stderr, error: null };
  } catch (e) {
    return { ok: false, status: null, stdout: "", stderr: "", error: e.message };
  }
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
