import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import {
  CreateStepDto,
  CreateTaskDto,
  TaskQueryDto,
  UpdateStepDto,
  UpdateTaskDto,
} from './dto/create-task.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Request } from 'express';
import { User } from '../users/entities/user.entity';

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  create(@Body() createTaskDto: CreateTaskDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.create(createTaskDto, user);
  }

  @Get()
  findAll(@Query() query: TaskQueryDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.findAll(user, query);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.findOne(id, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateTaskDto: UpdateTaskDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.update(id, updateTaskDto, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.remove(id, user);
  }

  @Post(':id/steps')
  addStep(@Param('id') id: string, @Body() createStepDto: CreateStepDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.addStep(id, createStepDto, user);
  }

  @Patch('steps/:stepId')
  updateStep(
    @Param('stepId') stepId: string,
    @Body() updateStepDto: UpdateStepDto,
    @Req() req: Request,
  ) {
    const user = req.user as User;
    return this.tasksService.updateStep(stepId, updateStepDto, user);
  }

  @Delete('steps/:stepId')
  removeStep(@Param('stepId') stepId: string, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.removeStep(stepId, user);
  }
}
