import 'reflect-metadata';
import * as fs from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { I18nService } from 'nestjs-i18n';
import * as bcrypt from 'bcryptjs';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { User } from './users/entities/user.entity';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

// 确保logs目录存在
function ensureLogsDirectory() {
  const logsDir = 'logs';
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    console.info('📁 日志目录已创建: logs/');
  }
}

// 确保上传目录存在
function ensureUploadDirectory(uploadDir: string) {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.info(`📁 上传目录已创建: ${uploadDir}`);
  }
}

async function seedDatabase(app: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ds = (app as any).get(DataSource);

  const userRepo = ds.getRepository(User);

  const userCount = await userRepo.count();

  if (userCount === 0) {
    // 创建加密密码
    const hashedPassword = await bcrypt.hash('123456', 10);

    await userRepo.save([
      {
        name: '张三',
        email: 'zhangsan@example.com',
        age: 28,
        password: hashedPassword,
        role: 'user',
      },
      {
        name: '李四',
        email: 'lisi@example.com',
        age: 32,
        password: hashedPassword,
        role: 'user',
      },
      {
        name: '管理员',
        email: 'admin@example.com',
        age: 30,
        password: hashedPassword,
        role: 'admin',
      },
    ]);
    console.info('用户种子数据已创建（默认密码：123456）');
  }
}

async function bootstrap() {
  // 确保日志目录存在
  ensureLogsDirectory();

  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const i18nService = app.get(I18nService);

  // 设置全局API前缀
  app.setGlobalPrefix('api');

  // 确保上传目录存在
  const uploadDest = configService.get<string>('upload.dest') ?? './uploads';
  ensureUploadDirectory(uploadDest);

  // 使用Winston作为默认logger
  const logger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(logger);

  // 安全头
  app.use(helmet());

  // 启用响应压缩
  app.use(compression());

  // 全局异常过滤器（注入i18n服务和logger）

  app.useGlobalFilters(new GlobalExceptionFilter(i18nService, logger));

  // 全局响应拦截器
  app.useGlobalInterceptors(new ResponseInterceptor());

  // 全局日志拦截器（仅在开发环境启用详细日志）
  if (configService.get<string>('nodeEnv') !== 'production') {
    app.useGlobalInterceptors(new LoggingInterceptor());
  }

  // 全局管道验证
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // 允许跨域
  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 设置API文档
  const config = new DocumentBuilder()
    .setTitle(configService.get<string>('app.name') ?? 'Orbit API')
    .setDescription(configService.get<string>('app.description') ?? 'API Documentation')
    .setVersion(configService.get<string>('app.version') ?? '1.0.0')
    .addBearerAuth() // 添加Bearer认证
    .addApiKey({ type: 'apiKey', name: 'X-Lang', in: 'header' }, 'lang')
    .addTag('用户认证')
    .addTag('用户管理')
    .addTag('清单管理')
    .addTag('任务管理')
    .addTag('标签管理')
    .addTag('协作分享')
    .addTag('文件上传')
    .addTag('语言管理')
    .addTag('健康检查')
    .addTag('数据库管理')
    .addTag('审计日志')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  // 初始化种子数据
  try {
    await seedDatabase(app);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.info('种子数据初始化跳过:', err.message);
  }

  const port = configService.get<number>('port') ?? 3001;
  await app.listen(port);

  const authEnabled = configService.get<boolean>('auth.enabled');

  console.info(`🚀 服务器启动在 http://localhost:${port}/api`);
  console.info(`📚 API文档地址: http://localhost:${port}/docs`);
  console.info(`💚 健康检查: http://localhost:${port}/api/health`);
  console.info(`🔗 API前缀: /api (所有接口都以/api开头)`);
  console.info(`🌍 环境: ${configService.get<string>('nodeEnv')}`);
  console.info('✅ 统一错误处理已启用');
  console.info(`${authEnabled ? '🔐' : '🔓'} JWT认证系统: ${authEnabled ? '已启用' : '已禁用'}`);
  console.info('✅ Winston日志系统已启用');
  console.info('🛡️ 安全防护已启用 (Helmet + 限流 + 压缩)');
  console.info('⚙️ 配置管理已启用');
  console.info('🌍 国际化(i18n)已启用 (中文/英文)');
  console.info('📝 日志文件位置: logs/');
  console.info('💡 语言切换: 请求头 X-Lang: zh/en');

  if (!authEnabled) {
    console.info('⚠️  警告: 认证已禁用，所有API接口无需JWT token即可访问！');
    console.info('⚠️  仅在开发/测试环境使用，生产环境请启用认证');
  }
}
bootstrap();
