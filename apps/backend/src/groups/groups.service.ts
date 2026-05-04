import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Group } from './entities/group.entity';
import { CreateGroupDto, UpdateGroupDto } from './dto/create-group.dto';
import { User } from '../users/entities/user.entity';

@Injectable()
export class GroupsService {
  constructor(
    @InjectRepository(Group)
    private groupsRepository: Repository<Group>,
  ) {}

  async create(createGroupDto: CreateGroupDto, user: User) {
    const maxOrder = await this.groupsRepository
      .createQueryBuilder('group')
      .where('group.userId = :userId', { userId: user.id })
      .select('MAX(group.sortOrder)', 'max')
      .getRawOne();

    const group = this.groupsRepository.create({
      ...createGroupDto,
      user,
      sortOrder: (maxOrder?.max ?? -1) + 1,
    });

    return this.groupsRepository.save(group);
  }

  async findAll(user: User) {
    return this.groupsRepository.find({
      where: { user: { id: user.id } },
      relations: ['lists'],
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  }

  async findOne(id: string, user: User) {
    const group = await this.groupsRepository.findOne({
      where: { id, user: { id: user.id } },
      relations: ['lists'],
    });

    if (!group) {
      throw new NotFoundException(`Group #${id} not found`);
    }

    return group;
  }

  async update(id: string, updateGroupDto: UpdateGroupDto, user: User) {
    const group = await this.findOne(id, user);
    Object.assign(group, updateGroupDto);
    return this.groupsRepository.save(group);
  }

  async remove(id: string, user: User) {
    const group = await this.findOne(id, user);
    return this.groupsRepository.remove(group);
  }

  async updateSortOrders(updates: { id: string; sortOrder: number }[], user: User) {
    await this.groupsRepository.manager.transaction(async (manager) => {
      for (const update of updates) {
        await manager.update(
          Group,
          { id: update.id, user: { id: user.id } },
          { sortOrder: update.sortOrder },
        );
      }
    });
  }
}
