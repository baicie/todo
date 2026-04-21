import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request } from 'express';
import { AuditLogService } from '../services/audit-log.service';
import { AuditAction, AuditEntityType } from '../entities/audit-log.entity';

export const AUDIT_LOG_KEY = 'audit_log';

export interface AuditMetadata {
  action: AuditAction;
  entityType: AuditEntityType;
  description?: string;
}

export const AuditLog = (metadata: AuditMetadata) =>
  Reflector.prototype.getAllAndOverride.bind(null, AUDIT_LOG_KEY, metadata);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly reflector: Reflector,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const auditMetadata = this.reflector.getAllAndOverride<AuditMetadata>(AUDIT_LOG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!auditMetadata) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = request.user as any;

    return next.handle().pipe(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tap(async (result: any) => {
        try {
          let entityId: number | undefined;
          if (result?.data?.id) {
            entityId = result.data.id;
          } else if (result?.id) {
            entityId = result.id;
          } else if (request.params?.id) {
            entityId = parseInt(request.params.id as string);
          }

          await this.auditLogService.log({
            action: auditMetadata.action,
            entityType: auditMetadata.entityType,
            entityId,
            userId: user?.id,
            userName: user?.name || user?.email,
            description:
              auditMetadata.description || `${auditMetadata.action} ${auditMetadata.entityType}`,
            newData: this.sanitizeData(result),
            request,
          });
        } catch {
          // 审计日志记录失败不应影响正常流程
        }
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sanitizeData(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const sanitized = { ...data };

    const sensitiveFields = ['password', 'token', 'secret', 'key'];
    sensitiveFields.forEach((field) => {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
      if (sanitized.data?.[field]) {
        sanitized.data[field] = '[REDACTED]';
      }
    });

    return sanitized;
  }
}
