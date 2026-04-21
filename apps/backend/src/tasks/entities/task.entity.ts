import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/entities/base-entity';
import { List } from '../../lists/entities/list.entity';
import { User } from '../../users/entities/user.entity';

@Entity('tasks')
export class Task extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, comment: '任务标题' })
  title: string;

  @Column({ type: 'text', nullable: true, comment: '任务备注' })
  description: string;

  @Column({ type: 'boolean', default: false, comment: '是否完成' })
  isCompleted: boolean;

  @Column({ type: 'boolean', default: false, comment: '是否重要' })
  isImportant: boolean;

  @Column({ type: 'boolean', default: false, comment: '是否添加到我的一天' })
  addToMyDay: boolean;

  @Column({ type: 'datetime', nullable: true, comment: '截止日期' })
  dueDate: Date;

  @Column({ type: 'datetime', nullable: true, comment: '提醒日期' })
  reminderDate: Date;

  @Column({ type: 'varchar', nullable: true, comment: '重复模式' })
  repeatPattern: string;

  @Column({ type: 'varchar', nullable: true, comment: '分类' })
  category: string;

  @Column({ type: 'json', nullable: true, comment: '附件文件' })
  files: unknown[];

  @ManyToOne(() => List, (list) => list.tasks, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'listId' })
  list: List;

  @Column({ nullable: true })
  listId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  userId: number;

  @OneToMany(() => Step, (step) => step.task, { cascade: true })
  steps: Step[];
}

@Entity('steps')
export class Step extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, comment: '步骤标题' })
  title: string;

  @Column({ type: 'boolean', default: false, comment: '是否完成' })
  isCompleted: boolean;

  @ManyToOne(() => Task, (task) => task.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'taskId' })
  task: Task;

  @Column({ nullable: true })
  taskId: string;
}
