import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  LoggerService,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { BusinessException, ErrorCode } from '../exceptions/business.exception';
import type { ErrorResponse } from '../interfaces/response.interface';
import { I18nService } from 'nestjs-i18n';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly i18n: I18nService<Record<string, unknown>>,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: LoggerService,
  ) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: HttpStatus;
    let message: string;
    let code: number;
    let details: any;

    // 获取当前语言
    const lang = (this.i18n as any).resolveLanguage
      ? (this.i18n as any).resolveLanguage(request)
      : 'zh';

    if (exception instanceof BusinessException) {
      // 业务异常
      const businessException = exception.getResponse() as any;
      status = exception.getStatus();
      code = businessException.code;

      // 如果有翻译key，使用翻译
      if (businessException.translationKey) {
        try {
          message = await this.i18n.translate(businessException.translationKey, {
            lang,
            args: businessException.translationArgs || {},
          });
        } catch (_translationError) {
          // 翻译失败时使用原始消息
          message = businessException.message;
        }
      } else {
        message = businessException.message;
      }
    } else if (exception instanceof HttpException) {
      // HTTP异常
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && 'message' in exceptionResponse) {
        const responseMessage = (exceptionResponse as any).message;
        message = Array.isArray(responseMessage)
          ? responseMessage.join(', ')
          : String(responseMessage);
        details = exceptionResponse;
      } else {
        message = String(exceptionResponse) || exception.message;
      }

      code = this.mapHttpStatusToErrorCode(status);

      // 尝试翻译常见的HTTP错误
      try {
        const translatedMessage = await this.i18n.translate(
          `common.${this.getHttpErrorKey(status)}`,
          {
            lang,
          },
        );
        if (translatedMessage !== `common.${this.getHttpErrorKey(status)}`) {
          message = translatedMessage;
        }
      } catch {
        // 翻译失败时保持原消息
      }
    } else {
      // 未知异常
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = ErrorCode.UNKNOWN_ERROR;

      // 强制在控制台输出详细错误信息
      console.error('🚨 UNKNOWN ERROR:', exception);
      if (exception instanceof Error) {
        console.error(exception.stack);
      }

      try {
        message = await this.i18n.translate('common.internalError', { lang });
      } catch {
        message = '服务器内部错误';
      }

      // 记录未知错误日志
      this.logger.error(
        `Unexpected error: ${exception}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // 记录错误日志
    const errorLog = {
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      status,
      code,
      message,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      details: details || (exception instanceof Error ? exception.message : String(exception)),
      stack: exception instanceof Error ? exception.stack : undefined,
    };

    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} - ${status} - ${message}`,
        errorLog, // 使用 errorLog 对象记录详细信息
        'GlobalExceptionFilter',
      );
    } else {
      this.logger.warn(
        `[${request.method}] ${request.url} - ${status} - ${message}`,
        errorLog, // 使用 errorLog 对象记录详细信息
        'GlobalExceptionFilter',
      );
    }

    const errorResponse: ErrorResponse = {
      success: false,
      code,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      details,
    };

    response.status(status).json(errorResponse);
  }

  private mapHttpStatusToErrorCode(status: HttpStatus): number {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      default:
        return ErrorCode.UNKNOWN_ERROR;
    }
  }

  private getHttpErrorKey(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'badRequest';
      case HttpStatus.UNAUTHORIZED:
        return 'unauthorized';
      case HttpStatus.FORBIDDEN:
        return 'forbidden';
      case HttpStatus.NOT_FOUND:
        return 'notFound';
      default:
        return 'error';
    }
  }
}
