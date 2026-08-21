// src/common/controllers/base.controller.ts
import { Get, Post, Put, Delete, Param, Body, Query, ParseIntPipe } from '@nestjs/common';
import { BaseService } from './base.service';
import { BaseEntity } from './base.entity';
import { PageCommon } from '@/page/page.vo';
import { ResponseUtil } from '@/util/response.util';
import { DeepPartial } from 'typeorm';

export abstract class BaseController<T extends BaseEntity, S extends BaseService<T>> {
  constructor(protected readonly service: S) {}

  /** 分页列表 */
  @Get()
  async findAll(@Query() pageDto: PageCommon) {
    const result = await this.service.paginate(pageDto);
    return ResponseUtil.success(result);
  }

  /** 根据 ID 查询 */
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const result = await this.service.findOne(id);
    return ResponseUtil.success(result);
  }

  /** 创建 */
  @Post()
  async create(@Body() data: DeepPartial<T>) {
    const result = await this.service.create(data);
    return ResponseUtil.success(result);
  }

  /** 更新 */
  @Put(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() data: DeepPartial<T>) {
    const result = await this.service.update(id, data);
    return ResponseUtil.success(result);
  }

  /** 删除（逻辑删除） */
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.service.delete(id);
    return ResponseUtil.success(true, '删除成功');
  }
}
