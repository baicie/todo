import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { List } from '../../lists/entities/list.entity';
import { BaseEntity } from '../../common/entities/base-entity';

export type SharePermission = 'view' | 'edit' | 'admin';

@Entity('shares')
export class Share extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36, comment: '分享码（随机字符串）' })
  shareCode: string;

  @Column({ type: 'varchar', length: 10, default: 'view', comment: '权限级别' })
  permission: SharePermission;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '分享标题（用于显示）' })
  title: string;

  @Column({ type: 'boolean', default: true, comment: '是否启用' })
  isActive: boolean;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @Column()
  ownerId: number;

  @ManyToOne(() => List, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'listId' })
  list: List;

  @Column()
  listId: string;

  @CreateDateColumn({ name: 'createdAt' })
  createdAt: Date;
}
