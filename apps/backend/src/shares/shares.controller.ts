import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SharesService } from './shares.service';
import { CreateShareDto, UpdateShareDto } from './dto/create-share.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { Request } from 'express';
import { User } from '../users/entities/user.entity';

@ApiTags('协作分享')
@Controller('shares')
export class SharesController {
  constructor(private readonly sharesService: SharesService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建分享链接' })
  @ApiResponse({ status: 201, description: '分享创建成功' })
  create(@Body() createShareDto: CreateShareDto, @Req() req: Request) {
    const user = req.user as User;
    return this.sharesService.create(createShareDto, user);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前用户的所有分享' })
  @ApiResponse({ status: 200, description: '返回分享列表' })
  findAll(@Req() req: Request) {
    const user = req.user as User;
    return this.sharesService.findAll(user);
  }

  @Get('resolve/:shareCode')
  @UseGuards(OptionalAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '解析分享权限' })
  @ApiParam({ name: 'shareCode', description: '分享码' })
  @ApiResponse({ status: 200, description: '返回分享权限' })
  @ApiResponse({ status: 404, description: '分享不存在或已失效' })
  resolveShare(@Param('shareCode') shareCode: string, @Req() req: Request) {
    const user = req.user as User | undefined;
    return this.sharesService.resolvePermission(shareCode, user?.id);
  }

  @Get('view/:shareCode')
  @UseGuards(OptionalAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '公开接口：获取分享清单信息（无需登录）' })
  @ApiParam({ name: 'shareCode', description: '分享码' })
  @ApiResponse({ status: 200, description: '返回分享清单及其任务' })
  @ApiResponse({ status: 404, description: '分享不存在或已失效' })
  getShareView(@Param('shareCode') shareCode: string, @Req() req: Request) {
    const user = req.user as User | undefined;
    return this.sharesService.getShareView(shareCode, user?.id);
  }

  @Get(':shareCode/tasks')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取分享清单的任务' })
  @ApiParam({ name: 'shareCode', description: '分享码' })
  @ApiResponse({ status: 200, description: '返回分享清单及其任务' })
  @ApiResponse({ status: 404, description: '分享不存在或已失效' })
  @ApiResponse({ status: 403, description: '无权限访问此分享' })
  getSharedListTasks(@Param('shareCode') shareCode: string, @Req() req: Request) {
    const user = req.user as User;
    return this.sharesService.getSharedListTasks(shareCode, user);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取指定分享详情' })
  @ApiResponse({ status: 200, description: '返回分享详情' })
  @ApiResponse({ status: 404, description: '分享不存在' })
  findOne(@Param('id') id: string, @Req() _req: Request) {
    return this.sharesService.findByShareCode(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新分享权限' })
  @ApiResponse({ status: 200, description: '分享更新成功' })
  @ApiResponse({ status: 404, description: '分享不存在' })
  update(@Param('id') id: string, @Body() updateShareDto: UpdateShareDto, @Req() req: Request) {
    const user = req.user as User;
    return this.sharesService.update(id, updateShareDto, user);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除分享' })
  @ApiResponse({ status: 200, description: '分享删除成功' })
  @ApiResponse({ status: 404, description: '分享不存在' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.sharesService.remove(id, user);
  }
}
