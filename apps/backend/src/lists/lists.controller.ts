import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ListsService } from './lists.service';
import { CreateListDto, UpdateListDto } from './dto/create-list.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Request } from 'express';
import { User } from '../users/entities/user.entity';

@ApiTags('清单管理')
@Controller('lists')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ListsController {
  constructor(private readonly listsService: ListsService) {}

  @Post()
  @ApiOperation({ summary: '创建清单' })
  @ApiResponse({ status: 201, description: '清单创建成功' })
  create(@Body() createListDto: CreateListDto, @Req() req: Request) {
    const user = req.user as User;
    return this.listsService.create(createListDto, user);
  }

  @Get()
  @ApiOperation({ summary: '获取当前用户的所有清单' })
  @ApiResponse({ status: 200, description: '返回清单列表' })
  findAll(@Req() req: Request) {
    const user = req.user as User;
    return this.listsService.findAll(user);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取指定清单详情' })
  @ApiResponse({ status: 200, description: '返回清单详情' })
  @ApiResponse({ status: 404, description: '清单不存在' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.listsService.findOne(id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新指定清单' })
  @ApiResponse({ status: 200, description: '清单更新成功' })
  @ApiResponse({ status: 404, description: '清单不存在' })
  update(@Param('id') id: string, @Body() updateListDto: UpdateListDto, @Req() req: Request) {
    const user = req.user as User;
    return this.listsService.update(id, updateListDto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除指定清单' })
  @ApiResponse({ status: 200, description: '清单删除成功' })
  @ApiResponse({ status: 404, description: '清单不存在' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.listsService.remove(id, user);
  }
}
