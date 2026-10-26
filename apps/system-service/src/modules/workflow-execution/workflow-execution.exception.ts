import { ProjectException } from '@nest-cloud/common';

/** 工作流执行边界只允许固定、无请求原文的业务错误。 */
export class WorkflowExecutionException extends ProjectException {
  constructor(error: { status: number; message: string }) {
    super(error.message, error.status);
  }
}
