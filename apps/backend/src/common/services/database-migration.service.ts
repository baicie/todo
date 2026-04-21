/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

export interface MigrationInfo {
  name: string;
  timestamp: number;
  executed: boolean;
  executedAt?: Date;
}

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  createdAt: Date;
}

@Injectable()
export class DatabaseMigrationService {
  private readonly logger = new Logger(DatabaseMigrationService.name);

  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  async getMigrations(): Promise<MigrationInfo[]> {
    try {
      const migrations = this.dataSource.migrations;
      let executedMigrations: any[] = [];

      try {
        executedMigrations = await this.dataSource.query(
          `SELECT * FROM migrations ORDER BY timestamp ASC`,
        );
      } catch {
        executedMigrations = [];
      }

      const executedMap = new Map(executedMigrations.map((m) => [m.name, m]));

      return migrations.map((migration) => ({
        name: (migration as { name?: string }).name || migration.constructor.name,
        timestamp: (migration as { timestamp?: number }).timestamp || Date.now(),
        executed: executedMap.has(
          (migration as { name?: string }).name || migration.constructor.name,
        ),
        executedAt: executedMap.get(
          (migration as { name?: string }).name || migration.constructor.name,
        )?.executedAt,
      }));
    } catch (error) {
      this.logger.error('获取迁移列表失败:', error);
      return [];
    }
  }

  async runMigrations(): Promise<{ executed: string[]; errors: any[] }> {
    const executed: string[] = [];
    const errors: any[] = [];

    try {
      const executedMigrations = await this.dataSource.runMigrations();

      executedMigrations.forEach((migration) => {
        executed.push(migration.name);
        this.logger.log(`迁移已执行: ${migration.name}`);
      });

      return { executed, errors };
    } catch (error) {
      this.logger.error('执行迁移失败:', error);
      errors.push(error);
      return { executed, errors };
    }
  }

  async revertLastMigration(): Promise<{ reverted?: string; error?: string }> {
    try {
      await this.dataSource.undoLastMigration();

      this.logger.log('迁移回滚完成');
      return { reverted: '最后一个迁移已回滚' };
    } catch (error) {
      const err = error as { message?: string };
      if (err.message?.includes('No migrations found')) {
        return { error: '没有可回滚的迁移' };
      }

      this.logger.error('回滚迁移失败:', error);
      return { error: err.message || '回滚失败' };
    }
  }

  async createBackup(backupName?: string): Promise<BackupInfo | null> {
    const name = backupName || `backup_${Date.now()}`;

    try {
      if (this.dataSource.options.type === 'sqljs') {
        return await this.createSqlJsBackup(name);
      }

      this.logger.warn('当前数据库类型不支持自动备份');
      return null;
    } catch (error) {
      this.logger.error('创建备份失败:', error);
      return null;
    }
  }

  private async createSqlJsBackup(name: string): Promise<BackupInfo> {
    const fs = require('node:fs');
    const path = require('node:path');

    const backupDir = './backups';
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const backupPath = path.join(backupDir, `${name}.db`);
    const currentDbPath = this.dataSource.options.database || 'database.sqljs';

    if (typeof currentDbPath === 'string' && fs.existsSync(currentDbPath)) {
      fs.copyFileSync(currentDbPath, backupPath);
    } else {
      const entities = this.dataSource.entityMetadatas;
      const backupData: Record<string, unknown> = {};

      for (const entity of entities) {
        const repository = this.dataSource.getRepository(entity.target);
        backupData[entity.tableName] = await repository.find();
      }

      fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
    }

    const stats = fs.statSync(backupPath);

    return {
      name,
      path: backupPath,
      size: stats.size,
      createdAt: new Date(),
    };
  }

  async getDatabaseStatus(): Promise<{
    connected: boolean;
    type: string;
    tablesCount: number;
    migrationsCount: number;
    pendingMigrationsCount: number;
  }> {
    try {
      const connected = this.dataSource.isInitialized;
      const type = this.dataSource.options.type;

      let tablesCount = 0;
      let migrationsCount = 0;
      let pendingMigrationsCount = 0;

      if (connected) {
        const tables = await this.dataSource.query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        );
        tablesCount = tables.length;

        const migrations = await this.getMigrations();
        migrationsCount = migrations.length;
        pendingMigrationsCount = migrations.filter((m) => !m.executed).length;
      }

      return {
        connected,
        type,
        tablesCount,
        migrationsCount,
        pendingMigrationsCount,
      };
    } catch (error) {
      this.logger.error('获取数据库状态失败:', error);
      return {
        connected: false,
        type: 'unknown',
        tablesCount: 0,
        migrationsCount: 0,
        pendingMigrationsCount: 0,
      };
    }
  }

  async getDatabaseSize(): Promise<{
    sizeInBytes: number;
    sizeFormatted: string;
  }> {
    try {
      if (this.dataSource.options.type === 'sqljs') {
        const dbPath = this.dataSource.options.database;
        if (typeof dbPath === 'string') {
          const fs = require('node:fs');
          if (fs.existsSync(dbPath)) {
            const stats = fs.statSync(dbPath);
            return {
              sizeInBytes: stats.size,
              sizeFormatted: this.formatBytes(stats.size),
            };
          }
        }
      }

      const result = await this.dataSource.query('PRAGMA page_count; PRAGMA page_size;');
      const pageCount = result[0]?.page_count || 0;
      const pageSize = result[1]?.page_size || 0;
      const sizeInBytes = pageCount * pageSize;

      return {
        sizeInBytes,
        sizeFormatted: this.formatBytes(sizeInBytes),
      };
    } catch (error) {
      this.logger.error('获取数据库大小失败:', error);
      return { sizeInBytes: 0, sizeFormatted: '0 B' };
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
