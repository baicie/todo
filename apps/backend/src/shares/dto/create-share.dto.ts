import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SharePermission } from '../entities/share.entity';

export class CreateShareDto {
  @IsString()
  @IsNotEmpty()
  listId: string;

  @IsEnum(['view', 'edit', 'admin'] as const)
  @IsOptional()
  permission?: SharePermission = 'view';

  @IsString()
  @IsOptional()
  title?: string;
}

export class UpdateShareDto {
  @IsEnum(['view', 'edit', 'admin'] as const)
  @IsOptional()
  permission?: SharePermission;

  @IsOptional()
  @IsNotEmpty()
  isActive?: boolean;
}
