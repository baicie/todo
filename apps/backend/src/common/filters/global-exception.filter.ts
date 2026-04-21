/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  LoggerService,
} from '@nestjs/common';
import type { Request, Response } from 'express';
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

    const i18nAny = this.i18n as unknown as Record<string, unknown>;

    const lang =
      typeof i18nAny.resolveLanguage === 'function'
        ? (this.i18n as any).resolveLanguage(request)
        : 'zh';

    if (exception instanceof BusinessException) {
      const businessException = exception.getResponse() as any;
      status = exception.getStatus();
      code = businessException.code;

      if (businessException.translationKey) {
        try {
          message = await this.i18n.translate(businessException.translationKey, {
            lang,
            args: businessException.translationArgs || {},
          });
        } catch {
          message = businessException.message;
        }
      } else {
        message = businessException.message;
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && 'message' in exceptionResponse) {
        const responseMessage = (exceptionResponse as any).message;
        message = Array.isArray(responseMessage)
          ? responseMessage.join(', ')
          : String(responseMessage);

        details = exceptionResponse as any;
      } else {
        message = String(exceptionResponse) || exception.message;
      }

      code = this.mapHttpStatusToErrorCode(status);

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
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = ErrorCode.UNKNOWN_ERROR;

      console.error('🚨 UNKNOWN ERROR:', exception);
      if (exception instanceof Error) {
        console.error(exception.stack);
      }

      try {
        message = await this.i18n.translate('common.internalError', { lang });
      } catch {
        message = '服务器内部错误';
      }

      this.logger.error(
        `Unexpected error: ${exception}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

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
        errorLog,
        'GlobalExceptionFilter',
      );
    } else {
      this.logger.warn(
        `[${request.method}] ${request.url} - ${status} - ${message}`,
        errorLog,
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
