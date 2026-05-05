import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateListDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  theme?: string;

  @IsOptional()
  @IsBoolean()
  isSmart?: boolean;

  @IsOptional()
  @IsUUID()
  groupId?: string;
}

export class UpdateListDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  theme?: string;

  @IsOptional()
  @IsBoolean()
  isSmart?: boolean;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  @IsOptional()
  sortOrder?: number;
}
