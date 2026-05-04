import { DataSource, EventSubscriber } from 'typeorm';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

@EventSubscriber()
@Injectable()
export class SqljsPersistenceSubscriber implements OnModuleInit, OnModuleDestroy {
  private dataSource: DataSource;
  private location: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private isDirty = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly injectedDataSource: DataSource,
  ) {
    this.dataSource = injectedDataSource;
  }

  onModuleInit() {
    this.location = this.configService.get<string>('database.location') || 'orbit-db';
    if (this.dataSource.options.type === 'sqljs') {
      this.dataSource.subscribers.push(this);
    }
  }

  onModuleDestroy() {
    if (this.dataSource.options.type === 'sqljs') {
      this.saveImmediately();
    }
  }

  afterInsert(event: any) {
    this.scheduleSave();
  }

  afterUpdate(event: any) {
    this.scheduleSave();
  }

  afterRemove(event: any) {
    this.scheduleSave();
  }

  private scheduleSave() {
    this.isDirty = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      if (this.isDirty) {
        this.saveImmediately();
        this.isDirty = false;
      }
    }, 1000);
  }

  private saveImmediately() {
    if (this.dataSource.options.type !== 'sqljs') return;

    try {
      const sqljsDriver = this.dataSource.driver as any;
      if (sqljsDriver?.database) {
        const data = sqljsDriver.database.export();
        const buffer = Buffer.from(data);

        const dir = dirname(this.location);
        if (dir && !existsSync(dir)) {
          const { mkdirSync } = require('node:fs');
          mkdirSync(dir, { recursive: true });
        }

        writeFileSync(this.location, buffer);
      }
    } catch (error) {
      console.error('SQL.js persistence error:', error);
    }
  }
}
