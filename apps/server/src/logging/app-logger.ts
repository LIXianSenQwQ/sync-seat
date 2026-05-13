import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { redactLogValue } from "./redact.js";

export type LogLevel = "error" | "warn" | "info" | "debug" | "verbose";

/**
 * 服务端统一日志入口，负责控制台输出和文件落盘。
 *
 * @author 清羽
 */
let logger: winston.Logger | null = null;

/**
 * 获取 Winston 实例，供 Nest Logger 适配器复用。
 *
 * @returns 全局 Winston logger。
 */
export function getWinstonLogger(): winston.Logger {
  logger ??= createAppLogger();
  return logger;
}

/**
 * 写入 info 级别业务日志。
 *
 * @param context 日志上下文。
 * @param message 日志消息。
 * @param metadata 结构化元数据。
 */
export function logInfo(context: string, message: string, metadata?: Record<string, unknown>): void {
  writeLog("info", context, message, metadata);
}

/**
 * 写入 warn 级别业务日志。
 *
 * @param context 日志上下文。
 * @param message 日志消息。
 * @param metadata 结构化元数据。
 */
export function logWarn(context: string, message: string, metadata?: Record<string, unknown>): void {
  writeLog("warn", context, message, metadata);
}

/**
 * 写入 error 级别业务日志。
 *
 * @param context 日志上下文。
 * @param message 日志消息。
 * @param metadata 结构化元数据。
 */
export function logError(context: string, message: string, metadata?: Record<string, unknown>): void {
  writeLog("error", context, message, metadata);
}

/**
 * 创建 Winston 日志器。
 *
 * @returns 已配置控制台和按天轮转文件输出的 logger。
 */
function createAppLogger(): winston.Logger {
  if (isTestRuntime()) {
    return winston.createLogger({
      silent: true,
      transports: [new winston.transports.Console()]
    });
  }

  loadLogEnvironmentFromRepo();
  const logDir = resolve(process.env.LOG_DIR ?? "logs");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => `${JSON.stringify(info)}`)
  );

  return winston.createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    format: jsonFormat,
    transports: [
      new winston.transports.Console(),
      new DailyRotateFile({
        dirname: logDir,
        filename: "app-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxFiles: process.env.LOG_RETENTION_DAYS ?? "14d",
        maxSize: process.env.LOG_MAX_FILE_SIZE ?? "20m"
      }),
      new DailyRotateFile({
        dirname: logDir,
        filename: "error-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        level: "error",
        maxFiles: process.env.LOG_RETENTION_DAYS ?? "14d",
        maxSize: process.env.LOG_MAX_FILE_SIZE ?? "20m"
      })
    ]
  });
}

/**
 * 判断当前是否处于单元测试进程。
 *
 * @returns 测试运行时返回 true。
 */
function isTestRuntime(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true" || process.env.npm_lifecycle_event === "test" || process.argv.some((arg) => arg.includes("vitest"));
}

/**
 * 写入结构化日志，并在入库前统一脱敏。
 *
 * @param level 日志级别。
 * @param context 日志上下文。
 * @param message 日志消息。
 * @param metadata 结构化元数据。
 */
function writeLog(level: LogLevel, context: string, message: string, metadata: Record<string, unknown> = {}): void {
  getWinstonLogger().log(level === "verbose" ? "debug" : level, message, {
    context,
    metadata: redactLogValue(metadata)
  });
}

/**
 * 在 Nest ConfigModule 初始化前预读取 .env 中的日志配置。
 */
function loadLogEnvironmentFromRepo(): void {
  const envPath = findRepoEnvPath();
  if (!envPath) {
    return;
  }

  // 步骤1：只预加载 LOG_* 字段，避免与 ConfigModule 的完整环境加载职责重叠。
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(LOG_[A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }
    process.env[match[1]] = stripEnvQuotes(match[2]);
  }
}

/**
 * 从当前工作目录向上寻找仓库 .env。
 *
 * @returns 找到时返回 .env 路径，否则返回 null。
 */
function findRepoEnvPath(): string | null {
  let current = process.cwd();
  while (true) {
    const envPath = join(current, ".env");
    if (existsSync(envPath)) {
      return envPath;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * 去掉 .env 值两侧的简单引号。
 *
 * @param value 原始环境变量值。
 * @returns 规范化后的环境变量值。
 */
function stripEnvQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
