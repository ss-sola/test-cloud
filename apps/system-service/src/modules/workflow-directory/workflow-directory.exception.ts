import { ProjectException } from '@nest-cloud/common';

/**
 * 工作流固定目录的受控异常：message 来自固定文案，不含路径、正文或系统错误。
 * revision 仅版本冲突时设置（文件已被删除为 null）；占用类 409 不设置，避免客户端误当作可确认的版本。
 */
export class WorkflowDirectoryException extends ProjectException {
  constructor(
    error: { status: number; message: string },
    readonly revision?: string | null,
  ) {
    super(error.message, error.status);
  }
}
