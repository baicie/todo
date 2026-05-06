import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { Step, Task } from './entities/task.entity';
import {
  CreateStepDto,
  CreateTaskDto,
  TaskQueryDto,
  UpdateStepDto,
  UpdateTaskDto,
} from './dto/create-task.dto';
import { User } from '../users/entities/user.entity';
import { List } from '../lists/entities/list.entity';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectRepository(Step)
    private stepsRepository: Repository<Step>,
    @InjectRepository(List)
    private listsRepository: Repository<List>,
  ) {}

  async create(createTaskDto: CreateTaskDto, user: User) {
    const task = this.tasksRepository.create({
      ...createTaskDto,
      user,
    });

    if (createTaskDto.listId) {
      const list = await this.listsRepository.findOne({
        where: { id: createTaskDto.listId, user: { id: user.id } },
      });
      if (!list) {
        throw new NotFoundException(`List #${createTaskDto.listId} not found`);
      }
      task.list = list;
    }

    return this.tasksRepository.save(task);
  }

  async findAll(user: User, query?: TaskQueryDto) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { user: { id: user.id } };

    if (query) {
      if (query.listId) {
        where.list = { id: query.listId };
      }

      if (query.isImportant !== undefined) {
        // 将字符串 'true'/'false' 转换为布尔值，或者直接使用（如果ValidationPipe已经处理）
        where.isImportant = query.isImportant === true || String(query.isImportant) === 'true';
      }

      if (query.addToMyDay !== undefined) {
        where.addToMyDay = query.addToMyDay === true || String(query.addToMyDay) === 'true';
      }

      if (query.hasDueDate !== undefined) {
        const hasDueDate = query.hasDueDate === true || String(query.hasDueDate) === 'true';
        where.dueDate = hasDueDate ? Not(IsNull()) : IsNull();
      }
    }

    return this.tasksRepository.find({
      where,
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
      relations: ['list', 'steps'],
    });
  }

  async findOne(id: string, user: User) {
    const task = await this.tasksRepository.findOne({
      where: { id, user: { id: user.id } },
      relations: ['list', 'steps'],
    });

    if (!task) {
      throw new NotFoundException(`Task #${id} not found`);
    }

    return task;
  }

  async update(id: string, updateTaskDto: UpdateTaskDto, user: User) {
    const task = await this.findOne(id, user);

    if (updateTaskDto.listId && updateTaskDto.listId !== task.list.id) {
      const list = await this.listsRepository.findOne({
        where: { id: updateTaskDto.listId, user: { id: user.id } },
      });
      if (!list) {
        throw new NotFoundException(`List #${updateTaskDto.listId} not found`);
      }
      task.list = list;
    }

    const updatedTask = this.tasksRepository.merge(task, updateTaskDto);
    return this.tasksRepository.save(updatedTask);
  }

  async remove(id: string, user: User) {
    const task = await this.findOne(id, user);
    return this.tasksRepository.remove(task);
  }

  async addStep(taskId: string, createStepDto: CreateStepDto, user: User) {
    const task = await this.findOne(taskId, user);
    const step = this.stepsRepository.create({
      ...createStepDto,
      task,
    });
    return this.stepsRepository.save(step);
  }

  async updateStep(stepId: string, updateStepDto: UpdateStepDto, user: User) {
    const step = await this.stepsRepository.findOne({
      where: { id: stepId },
      relations: ['task', 'task.user'],
    });

    if (!step) {
      throw new NotFoundException(`Step #${stepId} not found`);
    }

    if (step.task.user.id !== user.id) {
      throw new NotFoundException(`Step #${stepId} not found`);
    }

    const updatedStep = this.stepsRepository.merge(step, updateStepDto);
    return this.stepsRepository.save(updatedStep);
  }

  async removeStep(stepId: string, user: User) {
    const step = await this.stepsRepository.findOne({
      where: { id: stepId },
      relations: ['task', 'task.user'],
    });

    if (!step) {
      throw new NotFoundException(`Step #${stepId} not found`);
    }

    if (step.task.user.id !== user.id) {
      throw new NotFoundException(`Step #${stepId} not found`);
    }

    return this.stepsRepository.remove(step);
  }
}
