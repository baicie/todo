import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { Step, Task } from './entities/task.entity';
import { List } from '../lists/entities/list.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Task, Step, List])],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
