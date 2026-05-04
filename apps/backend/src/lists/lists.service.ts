import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { List } from './entities/list.entity';
import { CreateListDto, UpdateListDto } from './dto/create-list.dto';
import { User } from '../users/entities/user.entity';

@Injectable()
export class ListsService {
  constructor(
    @InjectRepository(List)
    private listsRepository: Repository<List>,
  ) {}

  async create(createListDto: CreateListDto, user: User) {
    const list = this.listsRepository.create({
      ...createListDto,
      user,
    });
    return this.listsRepository.save(list);
  }

  async findAll(user: User) {
    return this.listsRepository.find({
      where: { user: { id: user.id } },
      relations: ['group'],
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async findOne(id: string, user: User) {
    const list = await this.listsRepository.findOne({
      where: { id, user: { id: user.id } },
      relations: ['tasks'],
    });

    if (!list) {
      throw new NotFoundException(`List #${id} not found`);
    }

    return list;
  }

  async update(id: string, updateListDto: UpdateListDto, user: User) {
    const list = await this.findOne(id, user);
    const updatedList = this.listsRepository.merge(list, updateListDto);
    return this.listsRepository.save(updatedList);
  }

  async remove(id: string, user: User) {
    const list = await this.findOne(id, user);
    return this.listsRepository.remove(list);
  }
}
