import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateTaskDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;

  @IsOptional()
  @IsBoolean()
  isImportant?: boolean;

  @IsOptional()
  @IsBoolean()
  addToMyDay?: boolean;

  @IsOptional()
  dueDate?: string;

  @IsOptional()
  reminderDate?: string;

  @IsOptional()
  @IsString()
  repeatPattern?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  files?: any[];

  @IsOptional()
  @IsUUID()
  listId?: string;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;

  @IsOptional()
  @IsBoolean()
  isImportant?: boolean;

  @IsOptional()
  @IsBoolean()
  addToMyDay?: boolean;

  @IsOptional()
  dueDate?: string;

  @IsOptional()
  reminderDate?: string;

  @IsOptional()
  @IsString()
  repeatPattern?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  files?: any[];

  @IsOptional()
  @IsUUID()
  listId?: string;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tagIds?: string[];
}

export class CreateStepDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;
}

export class UpdateStepDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;
}

export class TaskQueryDto {
  @IsOptional()
  @IsUUID()
  listId?: string;

  @IsOptional()
  @IsBoolean()
  isImportant?: boolean;

  @IsOptional()
  @IsBoolean()
  addToMyDay?: boolean;

  @IsOptional()
  @IsBoolean()
  hasDueDate?: boolean;
}
