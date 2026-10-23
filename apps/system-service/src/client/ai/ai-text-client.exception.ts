import { ProjectException } from '@nest-cloud/common';

/** 模型客户端只抛出不含凭据、提示词或上游正文的受控异常。 */
export class AiTextClientException extends ProjectException {}
