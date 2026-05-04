import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from './entities/tag.entity';
import { CreateTagDto, UpdateTagDto } from './dto/create-tag.dto';
import { User } from '../users/entities/user.entity';

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(Tag)
    private tagsRepository: Repository<Tag>,
  ) {}

  async create(createTagDto: CreateTagDto, user: User) {
    const tag = this.tagsRepository.create({
      ...createTagDto,
      user,
    });
    return this.tagsRepository.save(tag);
  }

  async findAll(user: User) {
    return this.tagsRepository.find({
      where: { user: { id: user.id } },
      order: { createdAt: 'ASC' },
    });
  }

  async findOne(id: string, user: User) {
    const tag = await this.tagsRepository.findOne({
      where: { id, user: { id: user.id } },
    });

    if (!tag) {
      throw new NotFoundException(`Tag #${id} not found`);
    }

    return tag;
  }

  async update(id: string, updateTagDto: UpdateTagDto, user: User) {
    const tag = await this.findOne(id, user);
    const updatedTag = this.tagsRepository.merge(tag, updateTagDto);
    return this.tagsRepository.save(updatedTag);
  }

  async remove(id: string, user: User) {
    const tag = await this.findOne(id, user);
    return this.tagsRepository.remove(tag);
  }
}
