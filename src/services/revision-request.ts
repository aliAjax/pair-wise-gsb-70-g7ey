import type { ApiContract } from '../models/contract';
import { createOperationId } from './contract-queries';
import type { RevisionRequest } from './revision-control';

let cachedAuthor = '当前评审人';

export function setCurrentAuthor(author: string): void {
  cachedAuthor = author;
}

export function currentAuthor(): string {
  return cachedAuthor;
}

/**
 * 构造一次乐观锁提交：
 * expectedRevision/expectedBasisVersion 必须取自用户打开页面时的契约快照，
 * 不能用保存当下的最新值，否则两个窗口会互相放行。
 */
export function revisionRequest(
  contract: Pick<ApiContract, 'revision' | 'basisVersion'>,
  prefix: string,
  author?: string,
): RevisionRequest {
  return {
    expectedRevision: contract.revision,
    expectedBasisVersion: contract.basisVersion,
    operationId: createOperationId(prefix),
    author: author ?? cachedAuthor,
  };
}
