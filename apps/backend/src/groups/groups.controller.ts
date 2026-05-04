import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { User } from '../users/entities/user.entity';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GroupsService } from './groups.service';
import { CreateGroupDto, UpdateGroupDto } from './dto/create-group.dto';

@ApiTags('分组管理')
@Controller('groups')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Post()
  @ApiOperation({ summary: '创建分组' })
  @ApiResponse({ status: 201, description: '分组创建成功' })
  create(@Body() createGroupDto: CreateGroupDto, @Req() req: Request) {
    const user = req.user as User;
    return this.groupsService.create(createGroupDto, user);
  }

  @Get()
  @ApiOperation({ summary: '获取所有分组' })
  @ApiResponse({ status: 200, description: '返回分组列表' })
  findAll(@Req() req: Request) {
    const user = req.user as User;
    return this.groupsService.findAll(user);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取指定分组' })
  @ApiResponse({ status: 200, description: '返回分组详情' })
  @ApiResponse({ status: 404, description: '分组不存在' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.groupsService.findOne(id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新指定分组' })
  @ApiResponse({ status: 200, description: '分组更新成功' })
  @ApiResponse({ status: 404, description: '分组不存在' })
  update(@Param('id') id: string, @Body() updateGroupDto: UpdateGroupDto, @Req() req: Request) {
    const user = req.user as User;
    return this.groupsService.update(id, updateGroupDto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除指定分组' })
  @ApiResponse({ status: 200, description: '分组删除成功' })
  @ApiResponse({ status: 404, description: '分组不存在' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.groupsService.remove(id, user);
  }
}
