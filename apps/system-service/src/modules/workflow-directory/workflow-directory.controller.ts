import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import {
  WorkflowDirectoryFileQueryDto,
  WorkflowDirectorySaveDto,
} from './dto/workflow-directory.dto';
import { WorkflowDirectoryExceptionFilter } from './workflow-directory.filter';
import { WorkflowDirectoryService } from './workflow-directory.service';

@Controller('api/workflow-directory')
@UseFilters(WorkflowDirectoryExceptionFilter)
export class WorkflowDirectoryController {
  constructor(private readonly directoryService: WorkflowDirectoryService) {}

  /** 列出固定目录中的工作流文件。 */
  @Get('list')
  async list() {
    return ResponseUtil.success(await this.directoryService.list());
  }

  /** 读取单个工作流文件。 */
  @Get('document')
  async read(@Query() query: WorkflowDirectoryFileQueryDto) {
    return ResponseUtil.success(await this.directoryService.read(query.filename));
  }

  /** 按期望版本新建或覆盖单个工作流文件。 */
  @Post('document')
  @HttpCode(HttpStatus.OK)
  async save(@Body() body: WorkflowDirectorySaveDto) {
    return ResponseUtil.success(await this.directoryService.save(body));
  }
}
