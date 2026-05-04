import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/entities/base-entity';
import { User } from '../../users/entities/user.entity';
import { Task } from '../../tasks/entities/task.entity';
import { Group } from '../../groups/entities/group.entity';

@Entity('lists')
export class List extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, comment: '清单标题' })
  title: string;

  @Column({ type: 'varchar', nullable: true, comment: '清单图标' })
  icon: string;

  @Column({ type: 'varchar', nullable: true, comment: '清单颜色/主题' })
  theme: string;

  @Column({ type: 'boolean', default: false, comment: '是否为智能清单' })
  isSmart: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  userId: number;

  @ManyToOne(() => Group, (group) => group.lists, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'groupId' })
  group: Group;

  @Column({ nullable: true })
  groupId: string;

  @OneToMany(() => Task, (task) => task.list)
  tasks: Task[];
}
