/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import type { FindManyOptions, Repository, SelectQueryBuilder } from 'typeorm';
import { ILike } from 'typeorm';
import { PaginatedResponseDto, PaginationDto } from '../dto/pagination.dto';

@Injectable()
export class PaginationService {
  async paginate<T>(
    repository: Repository<T>,
    paginationDto: PaginationDto,
    options: FindManyOptions<T> = {},
    searchFields: (keyof T)[] = [],
  ): Promise<PaginatedResponseDto<T>> {
    const { page = 1, limit = 10, sortBy, sortOrder = 'DESC', search } = paginationDto;

    const findOptions: FindManyOptions<T> = {
      ...options,
      skip: (page - 1) * limit,
      take: limit,
    };

    if (sortBy) {
      findOptions.order = { [sortBy]: sortOrder } as any;
    }

    if (search && searchFields.length > 0) {
      const searchConditions = searchFields.map((field) => ({
        [field]: ILike(`%${search}%`),
      }));

      if (options.where) {
        findOptions.where = searchConditions.map((condition) => ({
          ...options.where,
          ...condition,
        })) as any;
      } else {
        findOptions.where = searchConditions as any;
      }
    }

    const [data, total] = await repository.findAndCount(findOptions);

    return new PaginatedResponseDto(data, total, page, limit);
  }

  async paginateQueryBuilder<T>(
    queryBuilder: SelectQueryBuilder<any>,
    paginationDto: PaginationDto,
  ): Promise<PaginatedResponseDto<T>> {
    const { page = 1, limit = 10, sortBy, sortOrder = 'DESC' } = paginationDto;

    if (sortBy) {
      queryBuilder.orderBy(sortBy, sortOrder);
    }

    queryBuilder.skip((page - 1) * limit).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return new PaginatedResponseDto(data, total, page, limit);
  }

  static getOffset(page: number, limit: number): number {
    return (page - 1) * limit;
  }

  static validatePagination(page: number, limit: number): { page: number; limit: number } {
    const validPage = Math.max(1, page);
    const validLimit = Math.min(Math.max(1, limit), 100);

    return { page: validPage, limit: validLimit };
  }
}
