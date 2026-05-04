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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
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

@ApiTags('任务管理')
@Controller('tasks')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @ApiOperation({ summary: '创建任务' })
  @ApiResponse({ status: 201, description: '任务创建成功' })
  create(@Body() createTaskDto: CreateTaskDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.create(createTaskDto, user);
  }

  @Get()
  @ApiOperation({ summary: '获取任务列表（支持多条件过滤）' })
  @ApiQuery({ name: 'listId', required: false, description: '清单ID' })
  @ApiQuery({ name: 'category', required: false, description: '分类' })
  @ApiQuery({ name: 'isCompleted', required: false, description: '是否完成' })
  @ApiQuery({ name: 'isImportant', required: false, description: '是否重要' })
  @ApiQuery({ name: 'addToMyDay', required: false, description: '是否添加到"我的一天"' })
  @ApiResponse({ status: 200, description: '返回任务列表' })
  findAll(@Query() query: TaskQueryDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.findAll(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取指定任务详情' })
  @ApiResponse({ status: 200, description: '返回任务详情' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.findOne(id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新指定任务' })
  @ApiResponse({ status: 200, description: '任务更新成功' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  update(@Param('id') id: string, @Body() updateTaskDto: UpdateTaskDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.update(id, updateTaskDto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除指定任务' })
  @ApiResponse({ status: 200, description: '任务删除成功' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.remove(id, user);
  }

  @Post(':id/steps')
  @ApiOperation({ summary: '为任务添加步骤' })
  @ApiResponse({ status: 201, description: '步骤添加成功' })
  addStep(@Param('id') id: string, @Body() createStepDto: CreateStepDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.addStep(id, createStepDto, user);
  }

  @Patch('steps/:stepId')
  @ApiOperation({ summary: '更新任务步骤' })
  @ApiResponse({ status: 200, description: '步骤更新成功' })
  updateStep(
    @Param('stepId') stepId: string,
    @Body() updateStepDto: UpdateStepDto,
    @Req() req: Request,
  ) {
    const user = req.user as User;
    return this.tasksService.updateStep(stepId, updateStepDto, user);
  }

  @Delete('steps/:stepId')
  @ApiOperation({ summary: '删除任务步骤' })
  @ApiResponse({ status: 200, description: '步骤删除成功' })
  removeStep(@Param('stepId') stepId: string, @Req() req: Request) {
    const user = req.user as User;
    return this.tasksService.removeStep(stepId, user);
  }
}
