import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';

@Injectable()
export class OptionalAuthGuard extends AuthGuard('jwt') {
  constructor(private configService: ConfigService) {
    super();
  }

  override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const authEnabled = this.configService.get<boolean>('auth.enabled');

    if (!authEnabled) {
      return true;
    }

    const result = super.canActivate(context);

    if (result instanceof Observable) {
      return result.pipe(
        map((active) => {
          if (!active) {
            const request = context.switchToHttp().getRequest();
            request.user = undefined;
          }
          return true;
        }),
      );
    }

    if (result instanceof Promise) {
      return result
        .then((active) => {
          if (!active) {
            const request = context.switchToHttp().getRequest();
            request.user = undefined;
          }
          return true;
        })
        .catch(() => {
          const request = context.switchToHttp().getRequest();
          request.user = undefined;
          return true;
        });
    }

    if (!result) {
      const request = context.switchToHttp().getRequest();
      request.user = undefined;
    }

    return result;
  }
}
