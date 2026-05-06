import { extname, join } from 'node:path';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { WinstonModule } from 'nest-winston';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import {
  AcceptLanguageResolver,
  CookieResolver,
  HeaderResolver,
  I18nModule,
  QueryResolver,
} from 'nestjs-i18n';
import { APP_GUARD } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { diskStorage } from 'multer';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { UploadsModule } from './uploads/uploads.module';
import { ListsModule } from './lists/lists.module';
import { TasksModule } from './tasks/tasks.module';
import { HealthModule } from './health/health.module';
import { LanguageModule } from './language/language.module';
import { winstonConfig } from './common/config/logger.config';
import { LoggerMiddleware } from './common/middleware/logger.middleware';
import configuration from './common/config/configuration';
import { configValidationSchema } from './common/config/config.schema';
import { AuditModule } from './audit/audit.module';
import { DatabaseModule } from './database/database.module';
import { TagsModule } from './tags/tags.module';
import { SharesModule } from './shares/shares.module';
import { GroupsModule } from './groups/groups.module';
import { SqljsPersistenceSubscriber } from './common/subscribers/sqljs-persistence.subscriber';

@Module({
  imports: [
    // 配置模块
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: configValidationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    // i18n国际化模块
    I18nModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        fallbackLanguage: configService.getOrThrow('FALLBACK_LANGUAGE'),
        loaderOptions: {
          path: join(__dirname, '/i18n/'),
          watch: true,
        },
      }),
      resolvers: [
        { use: CookieResolver, options: ['lang'] },
        { use: QueryResolver, options: ['lang'] },
        AcceptLanguageResolver,
        new HeaderResolver(['x-lang']),
      ],
      inject: [ConfigService],
    }),
    // Winston日志模块
    WinstonModule.forRoot(winstonConfig),
    // API限流配置
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => [
        {
          name: 'short',
          ttl: 1000,
          limit: 10,
        },
        {
          name: 'medium',
          ttl: configService.get<number>('security.throttle.ttl') ?? 60000,
          limit: configService.get<number>('security.throttle.limit') ?? 100,
        },
        {
          name: 'long',
          ttl: 60 * 60 * 1000,
          limit: 1000,
        },
      ],
    }),
    // TypeORM 配置
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
        const dbType = (configService.get<string>('database.type') ?? 'sqljs') as
          | 'postgres'
          | 'sqljs'
          | 'mysql'
          | 'sqlite';
        const dbConfig: TypeOrmModuleOptions = {
          type: dbType,
          autoLoadEntities: true,
          synchronize: configService.get<boolean>('database.synchronize') ?? true,
          logging: configService.get<boolean>('database.logging') ?? true,
        };
        if (dbType === 'sqljs') {
          Object.assign(dbConfig, {
            location: configService.get<string>('database.location') ?? 'orbit-db',
            autoSave: true,
          });
        } else if (dbType === 'sqlite') {
          Object.assign(dbConfig, {
            database: configService.get<string>('database.database') ?? 'orbit-db.sqlite',
          });
        } else {
          Object.assign(dbConfig, {
            host: configService.get<string>('database.host') ?? 'localhost',
            port: configService.get<number>('database.port') ?? 5432,
            username: configService.get<string>('database.username') ?? 'user',
            password: configService.get<string>('database.password') ?? 'password',
            database: configService.get<string>('database.database') ?? 'db',
          });
        }
        return dbConfig;
      },
    }),
    // Multer文件上传配置
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        storage: diskStorage({
          destination: configService.get<string>('upload.dest'),
          filename: (_, file, callback) => {
            const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
            const ext = extname(file.originalname);
            const filename = `${file.fieldname}-${uniqueSuffix}${ext}`;
            callback(null, filename);
          },
        }),
        limits: {
          fileSize: configService.get<number>('upload.maxFileSize'),
        },
      }),
    }),
    // 业务模块
    UsersModule,
    AuthModule,
    UploadsModule,
    ListsModule,
    TasksModule,
    TagsModule,
    SharesModule,
    GroupsModule,
    // 系统模块
    HealthModule,
    LanguageModule,
    AuditModule,
    DatabaseModule,
  ],
  providers: [
    // 全局启用限流守卫
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // SQL.js 持久化订阅器
    {
      provide: SqljsPersistenceSubscriber,
      inject: [ConfigService, DataSource],
      useFactory: (configService: ConfigService, dataSource: DataSource) => {
        return new SqljsPersistenceSubscriber(configService, dataSource);
      },
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*'); // 对所有路由应用日志中间件
  }
}
