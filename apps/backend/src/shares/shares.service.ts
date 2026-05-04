import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Share } from './entities/share.entity';
import { CreateShareDto, UpdateShareDto } from './dto/create-share.dto';
import { User } from '../users/entities/user.entity';

function generateShareCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

@Injectable()
export class SharesService {
  constructor(
    @InjectRepository(Share)
    private sharesRepository: Repository<Share>,
  ) {}

  async create(createShareDto: CreateShareDto, user: User) {
    const share = this.sharesRepository.create({
      ...createShareDto,
      owner: user,
      ownerId: user.id,
      shareCode: generateShareCode(),
    });
    return this.sharesRepository.save(share);
  }

  async findAll(user: User) {
    return this.sharesRepository.find({
      where: { owner: { id: user.id } },
      relations: ['list'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByShareCode(shareCode: string) {
    const share = await this.sharesRepository.findOne({
      where: { shareCode, isActive: true },
      relations: ['list'],
    });
    if (!share) {
      throw new NotFoundException('分享不存在或已失效');
    }
    return share;
  }

  async resolvePermission(shareCode: string, userId: number) {
    const share = await this.sharesRepository.findOne({
      where: { shareCode, isActive: true },
    });
    if (!share) {
      throw new NotFoundException('分享不存在或已失效');
    }
    if (share.ownerId === userId) {
      return 'admin';
    }
    return share.permission;
  }

  async update(id: string, updateShareDto: UpdateShareDto, user: User) {
    const share = await this.sharesRepository.findOne({
      where: { id, owner: { id: user.id } },
    });
    if (!share) {
      throw new NotFoundException(`Share #${id} not found`);
    }
    const updatedShare = this.sharesRepository.merge(share, updateShareDto);
    return this.sharesRepository.save(updatedShare);
  }

  async remove(id: string, user: User) {
    const share = await this.sharesRepository.findOne({
      where: { id, owner: { id: user.id } },
    });
    if (!share) {
      throw new NotFoundException(`Share #${id} not found`);
    }
    return this.sharesRepository.remove(share);
  }

  async getSharedListTasks(shareCode: string, user: User) {
    const share = await this.sharesRepository.findOne({
      where: { shareCode, isActive: true },
      relations: ['list', 'list.tasks'],
    });
    if (!share) {
      throw new NotFoundException('分享不存在或已失效');
    }
    if (share.permission === 'view' || share.permission === 'edit' || share.ownerId === user.id) {
      return {
        list: share.list,
        permission: share.ownerId === user.id ? 'admin' : share.permission,
      };
    }
    throw new ForbiddenException('无权限访问此分享');
  }
}
