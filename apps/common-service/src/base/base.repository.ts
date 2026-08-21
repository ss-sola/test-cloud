import { Repository } from 'typeorm';
import { BaseEntity } from './base.entity';

export class BaseRepository<T extends BaseEntity> extends Repository<T> {}
