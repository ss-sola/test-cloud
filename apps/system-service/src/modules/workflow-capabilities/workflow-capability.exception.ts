import { ProjectException } from '@nest-cloud/common';

/**
 * 工作流原子能力的受控异常：message 由代码固定生成，不包含请求原文、凭据或上游响应，
 * 因此可以直接返回给调用方；专用 filter 只放行此类异常的消息。
 */
export class WorkflowCapabilityException extends ProjectException {}
