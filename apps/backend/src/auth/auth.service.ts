import { ConflictException, Injectable } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserRole } from '../users/entities/user.entity';
import { InvalidCredentialsException } from '../common/exceptions/business.exception';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import type { JwtPayload } from './jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.usersRepository.findOne({
      where: { email },
      select: ['id', 'email', 'name', 'role', 'password'],
    });

    if (user && (await bcrypt.compare(password, user.password))) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { password: _pw, ...result } = user;
      return result as User;
    }
    return null;
  }

  async validateUserById(userId: number): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id: userId } });
  }

  async login(loginDto: LoginDto) {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    if (!user) {
      throw new InvalidCredentialsException();
    }

    const payload: JwtPayload = {
      email: user.email,
      sub: user.id,
      role: user.role,
    };

    const options: JwtSignOptions = loginDto.rememberMe ? { expiresIn: '30d' } : {};

    return {
      access_token: this.jwtService.sign(payload, options),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async register(registerDto: RegisterDto) {
    // 检查用户是否已存在
    const existingUser = await this.usersRepository.findOne({
      where: { email: registerDto.email },
    });

    if (existingUser) {
      throw new ConflictException('邮箱已被注册');
    }

    // 哈希密码
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(registerDto.password, saltRounds);

    // 创建新用户
    const user = this.usersRepository.create({
      name: registerDto.name,
      email: registerDto.email,
      age: registerDto.age ?? 18,
      password: hashedPassword,
      role: registerDto.role ?? UserRole.USER,
    });

    const savedUser = await this.usersRepository.save(user);

    // 生成JWT
    const payload: JwtPayload = {
      email: savedUser.email,
      sub: savedUser.id,
      role: savedUser.role,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: savedUser.id,
        email: savedUser.email,
        name: savedUser.name,
        role: savedUser.role,
      },
    };
  }
}
