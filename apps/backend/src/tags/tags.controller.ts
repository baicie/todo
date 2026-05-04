import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TagsService } from './tags.service';
import { CreateTagDto, UpdateTagDto } from './dto/create-tag.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Request } from 'express';
import { User } from '../users/entities/user.entity';

@ApiTags('标签管理')
@Controller('tags')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Post()
  @ApiOperation({ summary: '创建标签' })
  @ApiResponse({ status: 201, description: '标签创建成功' })
  create(@Body() createTagDto: CreateTagDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tagsService.create(createTagDto, user);
  }

  @Get()
  @ApiOperation({ summary: '获取当前用户的所有标签' })
  @ApiResponse({ status: 200, description: '返回标签列表' })
  findAll(@Req() req: Request) {
    const user = req.user as User;
    return this.tagsService.findAll(user);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取指定标签详情' })
  @ApiResponse({ status: 200, description: '返回标签详情' })
  @ApiResponse({ status: 404, description: '标签不存在' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.tagsService.findOne(id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新指定标签' })
  @ApiResponse({ status: 200, description: '标签更新成功' })
  @ApiResponse({ status: 404, description: '标签不存在' })
  update(@Param('id') id: string, @Body() updateTagDto: UpdateTagDto, @Req() req: Request) {
    const user = req.user as User;
    return this.tagsService.update(id, updateTagDto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除指定标签' })
  @ApiResponse({ status: 200, description: '标签删除成功' })
  @ApiResponse({ status: 404, description: '标签不存在' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.tagsService.remove(id, user);
  }
}
