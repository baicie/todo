import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private configService: ConfigService) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    // 检查是否启用了认证
    const authEnabled = this.configService.get<boolean>('auth.enabled');

    if (!authEnabled) {
      // 如果认证被禁用，模拟一个默认用户并附加到请求对象上
      const request = context.switchToHttp().getRequest();
      request.user = {
        id: 1, // 默认用户ID
        email: 'default@example.com',
        role: 'user',
        name: 'Default User',
      };
      // console.log('🔓 认证已禁用，使用默认用户身份');
      return true;
    }

    // 如果认证启用，执行正常的JWT验证
    return super.canActivate(context);
  }
}
