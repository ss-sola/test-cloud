import { ProjectException } from '@nest-cloud/common';
import type { CompareInputErrors } from './content-compare.types';

export class ContentCompareException extends ProjectException {
  constructor(
    message: string,
    readonly errors?: CompareInputErrors,
    status = 400,
  ) {
    super(message, status);
  }
}
