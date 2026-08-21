// src/common/entities/base.entity.ts
import {
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BaseEntity as TypeORMBaseEntity,
  DeleteDateColumn,
} from 'typeorm';

export abstract class BaseEntity extends TypeORMBaseEntity {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id!: number;

  @Column({
    name: 'create_user',
    type: 'int',
    nullable: true,
    comment: '创建人账号ID',
  })
  createUser!: number;

  @Column({
    name: 'update_user',
    type: 'int',
    nullable: true,
    comment: '最后更新人账号ID',
  })
  updateUser!: number;

  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', comment: '最后更新时间' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', comment: '删除时间，空值表示未删除' })
  deletedAt?: Date;
}
