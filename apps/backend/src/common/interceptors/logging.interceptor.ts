import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const className = context.getClass().name;
    const methodName = context.getHandler().name;
    const startTime = Date.now();
    const logPrefix = `${className}.${methodName}`;

    this.logger.debug(`${logPrefix} - 开始执行`);

    return next.handle().pipe(
      tap(() => {
        const endTime = Date.now();
        const duration = endTime - startTime;
        this.logger.debug(`${logPrefix} - 执行完成 (${duration}ms)`);
      }),
      catchError((error: unknown) => {
        const endTime = Date.now();
        const duration = endTime - startTime;
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(`${logPrefix} - 执行失败 (${duration}ms): ${msg}`, stack);
        throw error;
      }),
    );
  }
}
