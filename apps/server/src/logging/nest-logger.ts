import type { LoggerService } from "@nestjs/common";
import { getWinstonLogger } from "./app-logger.js";

/**
 * Nest LoggerService 适配器，用统一 Winston 实例接管框架日志。
 *
 * @author 清羽
 */
export class WinstonNestLogger implements LoggerService {
  private readonly logger = getWinstonLogger();

  /**
   * 写入普通 Nest 日志。
   *
   * @param message 日志内容。
   * @param context 可选 Nest 上下文。
   */
  log(message: unknown, context?: string): void {
    this.logger.info(formatMessage(message), { context });
  }

  /**
   * 写入错误 Nest 日志。
   *
   * @param message 日志内容。
   * @param trace 错误堆栈。
   * @param context 可选 Nest 上下文。
   */
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error(formatMessage(message), { context, stack: trace });
  }

  /**
   * 写入警告 Nest 日志。
   *
   * @param message 日志内容。
   * @param context 可选 Nest 上下文。
   */
  warn(message: unknown, context?: string): void {
    this.logger.warn(formatMessage(message), { context });
  }

  /**
   * 写入调试 Nest 日志。
   *
   * @param message 日志内容。
   * @param context 可选 Nest 上下文。
   */
  debug(message: unknown, context?: string): void {
    this.logger.debug(formatMessage(message), { context });
  }

  /**
   * 写入详细 Nest 日志。
   *
   * @param message 日志内容。
   * @param context 可选 Nest 上下文。
   */
  verbose(message: unknown, context?: string): void {
    this.logger.debug(formatMessage(message), { context });
  }
}

/**
 * 将 Nest 传入的任意消息转成稳定字符串。
 *
 * @param message Nest 日志消息。
 * @returns 可写入日志的字符串。
 */
function formatMessage(message: unknown): string {
  return typeof message === "string" ? message : JSON.stringify(message);
}
