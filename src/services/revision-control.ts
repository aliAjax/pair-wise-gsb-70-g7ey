import { stableChecksum } from '../lib/utils';
import type {
  ApiContract,
  ContractChange,
  RevisionLogEntry,
} from '../models/contract';

/** 乐观锁提交的公共参数：保存必须带上当前修订号和依据版本 */
export interface RevisionRequest {
  /** 提交方打开页面时看到的修订号 */
  expectedRevision: number;
  /** 提交方依据的已冻结版本（未发布过为空字符串） */
  expectedBasisVersion: string;
  /** 幂等键：同一次保存重试不产生新版本/豁免/重复修订 */
  operationId: string;
  author: string;
}

/** 冲突时描述对方在本字段上的改动 */
export interface RemoteFieldChange {
  changeId: string;
  path: string;
  field: keyof ContractChange;
  label: string;
  baseValue: string;
  remoteValue: string;
  remoteAuthor: string;
  remoteAt: string;
  remoteRevision: number;
}

export interface MergeableSave {
  kind: 'fields';
  changeId: string;
  patch: Partial<Pick<ContractChange, 'impactStatement' | 'migrationPlan'>>;
}

export class RevisionConflictError extends Error {
  readonly code = 'revision_conflict';
  readonly currentRevision: number;
  readonly currentBasisVersion: string;
  readonly remoteChanges: RemoteFieldChange[];
  /** 当前修订的契约快照，供页面合并后重提 */
  readonly currentContract: ApiContract;

  constructor(currentContract: ApiContract, remoteChanges: RemoteFieldChange[]) {
    super('契约已被其他窗口更新，请先查看对方变更并合并后再保存。');
    this.name = 'RevisionConflictError';
    this.currentRevision = currentContract.revision;
    this.currentBasisVersion = currentContract.basisVersion;
    this.remoteChanges = remoteChanges;
    this.currentContract = currentContract;
  }
}

export class FrozenContractError extends Error {
  readonly code = 'frozen_contract';
  constructor() {
    super('契约已冻结，冻结时固化的变更、调用方、豁免和校验值不能再修改。');
    this.name = 'FrozenContractError';
  }
}

export class FrozenSnapshotError extends Error {
  readonly code = 'frozen_snapshot';
  constructor(message: string) {
    super(message);
    this.name = 'FrozenSnapshotError';
  }
}

const CHANGE_FIELD_LABELS: Partial<Record<keyof ContractChange, string>> = {
  impactStatement: '调用方影响说明',
  migrationPlan: '迁移方案',
  reviewState: '评审结论',
  reviewer: '评审人',
  reviewComment: '评审意见',
  reviewedAt: '评审时间',
};

export function appendLog(
  contract: ApiContract,
  entry: Omit<RevisionLogEntry, 'revision' | 'at' | 'basisVersion'> & { at?: string },
): RevisionLogEntry[] {
  const log = contract.revisionLog ?? [];
  return [
    ...log,
    {
      revision: contract.revision,
      basisVersion: contract.basisVersion,
      at: entry.at ?? new Date().toISOString(),
      ...entry,
    },
  ].slice(-200);
}

/** 幂等检查：相同 operationId 的提交已经成功过，重试直接返回，不重复应用 */
export function findAppliedOperation(
  contract: ApiContract,
  operationId: string,
): RevisionLogEntry | undefined {
  return (contract.revisionLog ?? []).find((entry) => entry.operationId === operationId);
}

export function assertNotFrozen(contract: ApiContract): void {
  if (contract.status === 'frozen') {
    throw new FrozenContractError();
  }
}

/**
 * 乐观锁校验：只接收基于当前修订且依据版本一致的改动。
 * 修订号或依据版本不一致时抛出冲突，由调用方列出对方变更。
 */
export function assertCurrentRevision(
  contract: ApiContract,
  request: Pick<RevisionRequest, 'expectedRevision' | 'expectedBasisVersion'>,
): void {
  if (
    contract.revision === request.expectedRevision &&
    contract.basisVersion === (request.expectedBasisVersion ?? '')
  ) {
    return;
  }
  throw new RevisionConflictError(contract, []);
}

/** 找到对方在当前变更项上的最近一次操作记录 */
export function latestChangeLog(
  contract: ApiContract,
  changeId: string,
): RevisionLogEntry | undefined {
  return [...(contract.revisionLog ?? [])]
    .reverse()
    .find((entry) => entry.changeIds.includes(changeId));
}

/**
 * 列出对方相对提交方基准值改动过的字段，用于冲突页先展示对方变更。
 * baseValues 为提交方打开时的字段值，incomingPatch 为本次想写入的内容。
 */
export function diffRemoteEdits(
  currentContract: ApiContract,
  changeId: string,
  baseValues: Partial<Record<keyof ContractChange, string>>,
  incomingPatch: MergeableSave['patch'],
): RemoteFieldChange[] {
  const currentChange = currentContract.changes.find((change) => change.id === changeId);
  if (!currentChange) {
    return [];
  }
  const log = latestChangeLog(currentContract, changeId);
  return (Object.keys(incomingPatch) as Array<keyof typeof incomingPatch>).flatMap<RemoteFieldChange>(
    (field) => {
      const baseValue = baseValues[field] ?? '';
      const remoteValue = String(currentChange[field] ?? '');
      // 当前值与基准相同，说明对方没有动过该字段
      if (baseValue === remoteValue) {
        return [];
      }
      return [
        {
          changeId,
          path: currentChange.path,
          field: field as keyof ContractChange,
          label: CHANGE_FIELD_LABELS[field] ?? String(field),
          baseValue,
          remoteValue,
          remoteAuthor: log?.author ?? '另一个窗口',
          remoteAt: log?.at ?? currentContract.updatedAt,
          remoteRevision: log?.revision ?? currentContract.revision,
        },
      ];
    },
  );
}

/** 字段级合并：以当前修订为底，覆盖合并后的字段，对方未触碰的字段自然保留 */
export function mergeChangePatch(
  currentChange: ContractChange,
  mergedPatch: MergeableSave['patch'],
): ContractChange {
  return { ...currentChange, ...mergedPatch };
}

/**
 * 冻结快照完整性校验：
 * 固化校验值必须与固化 OpenAPI 重新计算一致，且固化清单必须存在。
 * legacy 快照来自迁移前数据，只告警不阻断。
 */
export function verifyFrozenSnapshots(contract: ApiContract): string[] {
  const problems: string[] = [];
  for (const version of contract.versions) {
    if (version.snapshotStatus === 'legacy') {
      continue;
    }
    if (stableChecksum(version.openapi) !== version.checksum) {
      problems.push(`版本 v${version.version} 的校验值与固化定义不一致。`);
    }
    if (
      !version.frozenChanges.length &&
      !version.frozenExemptions.length &&
      !version.frozenConsumers.length
    ) {
      problems.push(`版本 v${version.version} 缺少固化的变更、调用方与豁免清单。`);
    }
  }
  return problems;
}

export function summarizeSave(save: MergeableSave): string {
  const fields = Object.keys(save.patch);
  return `更新变更项 ${save.changeId} 的 ${fields.join('、') || '说明字段'}`;
}
