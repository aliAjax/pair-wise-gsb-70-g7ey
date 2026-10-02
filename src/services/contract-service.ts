import { seedContracts } from '../data/seed';
import {
  stableChecksum,
  formatDateTime,
} from '../lib/utils';
import type {
  ApiContract,
  ContractChange,
  ContractVersion,
  Exemption,
  ReviewState,
  RevisionLogEntry,
} from '../models/contract';
import { effectiveView } from '../models/contract';
export { effectiveView, validateForRelease } from '../models/contract';
import {
  type RevisionRequest,
  type MergeableSave,
  type RemoteFieldChange,
  RevisionConflictError,
  FrozenContractError,
  FrozenSnapshotError,
  appendLog,
  findAppliedOperation,
  assertNotFrozen,
  assertCurrentRevision,
  diffRemoteEdits,
  mergeChangePatch,
  verifyFrozenSnapshots,
  summarizeSave,
} from './revision-control';
import { migrateContracts } from './migration';

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const QUEUE_KEY = 'pair-wise-gsb-70-pending-ops';
/** 演示开关：置位后下一次持久化会失败，用于验证“写入失败保留待恢复批次” */
const FAIL_NEXT_KEY = 'pair-wise-gsb-70-fail-next-write';
const LATENCY = 180;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

/* ------------------------------------------------------------------ */
/* 持久化与待恢复批次                                                    */
/* ------------------------------------------------------------------ */

export class StorageWriteError extends Error {
  readonly code = 'storage_write_failed';
  readonly batch: PendingOperation;
  constructor(batch: PendingOperation, cause: unknown) {
    super('写入失败，操作已保留为待恢复批次，网络恢复后可重试。');
    this.name = 'StorageWriteError';
    this.batch = batch;
    this.cause = cause as Error;
  }
}

export type PendingOperation =
  | { id: string; type: 'fields'; createdAt: string; payload: FieldsPayload }
  | { id: string; type: 'openapi'; createdAt: string; payload: OpenApiPayload }
  | { id: string; type: 'review'; createdAt: string; payload: ReviewPayload }
  | { id: string; type: 'bulk_review'; createdAt: string; payload: BulkReviewPayload }
  | { id: string; type: 'exemption'; createdAt: string; payload: ExemptionPayload }
  | { id: string; type: 'freeze'; createdAt: string; payload: FreezePayload }
  | { id: string; type: 'new_draft'; createdAt: string; payload: NewDraftPayload };

interface FieldsPayload {
  contractId: string;
  changeId: string;
  baseValues: Partial<Record<keyof ContractChange, string>>;
  patch: MergeableSave['patch'];
  request: RevisionRequest;
}
interface OpenApiPayload {
  contractId: string;
  openapi: string;
  request: RevisionRequest;
}
interface ReviewPayload {
  contractId: string;
  changeId: string;
  state: ReviewState;
  reviewer: string;
  comment: string;
  request: RevisionRequest;
}
interface BulkReviewPayload {
  selections: Array<{ contractId: string; changeId: string }>;
  state: ReviewState;
  reviewer: string;
  comment: string;
  bases: Record<string, { revision: number; basisVersion: string }>;
  request: RevisionRequest;
}
interface ExemptionPayload {
  contractId: string;
  changeId: string;
  reason: string;
  request: RevisionRequest;
}
interface FreezePayload {
  contractId: string;
  version: string;
  notes: string;
  request: RevisionRequest;
}
interface NewDraftPayload {
  contractId: string;
  nextVersion: string;
  request: RevisionRequest;
}

/** 测试/演示用：让下一次写入失败 */
export function armNextWriteFailure(): void {
  localStorage.setItem(FAIL_NEXT_KEY, '1');
}

function persistContracts(contracts: ApiContract[]): void {
  if (localStorage.getItem(FAIL_NEXT_KEY) === '1') {
    localStorage.removeItem(FAIL_NEXT_KEY);
    throw new Error('模拟存储不可用（配额/隐私模式/网络盘失败）');
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contracts));
}

function enqueuePending(operation: PendingOperation): void {
  const queue = listPendingOperationsRaw().filter((item) => item.id !== operation.id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify([...queue, operation]));
}

function removePending(id: string): void {
  const queue = listPendingOperationsRaw().filter((item) => item.id !== id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function listPendingOperationsRaw(): PendingOperation[] {
  const stored = localStorage.getItem(QUEUE_KEY);
  if (!stored) {
    return [];
  }
  try {
    return JSON.parse(stored) as PendingOperation[];
  } catch {
    return [];
  }
}

export function listPendingOperations(): PendingOperation[] {
  return listPendingOperationsRaw();
}

export function discardPendingOperation(id: string): void {
  removePending(id);
}

/**
 * 执行一次提交并持久化；写入失败时把操作保留为待恢复批次。
 * mutate 必须是纯内存计算，所有确定性产物（版本号、豁免 id）都在 mutate 内生成，
 * 因此恢复重试走同一路径时，已成功的提交会被 operationId 幂等命中，
 * 不会重复生成版本或豁免。
 */
function commit(
  operation: PendingOperation,
  mutate: (contracts: ApiContract[]) => ApiContract[],
): ApiContract[] {
  const contracts = readContractsRaw();
  // 业务错误（冲突/冻结）直接向上抛出，不会入待恢复队列
  const next = mutate(contracts);
  try {
    persistContracts(next);
  } catch (error) {
    enqueuePending(operation);
    throw new StorageWriteError(operation, error);
  }
  return next;
}

/** 重试待恢复批次；幂等：重复重试不会重复生成版本或豁免 */
export async function recoverPendingOperations(): Promise<{
  recovered: number;
  failed: PendingOperation[];
}> {
  const queue = listPendingOperationsRaw();
  const failed: PendingOperation[] = [];
  let recovered = 0;
  for (const operation of queue) {
    try {
      await replayOperation(operation);
      removePending(operation.id);
      recovered += 1;
    } catch (error) {
      if (error instanceof StorageWriteError) {
        failed.push(operation);
      } else {
        // 冲突/冻结等业务错误：批次已无法按原样应用，保留并交由用户处理
        failed.push(operation);
      }
    }
  }
  return { recovered, failed };
}

async function replayOperation(operation: PendingOperation): Promise<ApiContract | ApiContract[]> {
  switch (operation.type) {
    case 'fields':
      return applyFields(operation.payload, operation);
    case 'openapi':
      return applyOpenApi(operation.payload, operation);
    case 'review':
      return applyReview(operation.payload, operation);
    case 'bulk_review':
      return applyBulkReview(operation.payload, operation);
    case 'exemption':
      return applyExemption(operation.payload, operation);
    case 'freeze':
      return applyFreeze(operation.payload, operation);
    case 'new_draft':
      return applyNewDraft(operation.payload, operation);
  }
}

/* ------------------------------------------------------------------ */
/* 读取与迁移                                                           */
/* ------------------------------------------------------------------ */

function readContractsRaw(): ApiContract[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as unknown[];
      const { contracts, migrated } = migrateContracts(parsed);
      if (migrated) {
        // 迁移本身也要落盘；落盘失败则本次会话仍使用迁移结果
        try {
          persistContracts(contracts);
        } catch {
          // 下次打开会再次迁移，幂等
        }
      }
      return contracts;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  // seed 本身就是最新形状；迁移函数用于兜底（例如 seed 字段调整时）
  const seeded = clone(seedContracts) as unknown[];
  const { contracts } = migrateContracts(seeded);
  try {
    persistContracts(contracts);
  } catch {
    // 首次写入失败时仍返回内存数据
  }
  return contracts;
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait();
  return readContractsRaw();
}

export async function getContract(id: string): Promise<ApiContract | undefined> {
  const contracts = await listContracts();
  return contracts.find((contract) => contract.id === id);
}

/** 冻结快照完整性问题（校验值不符/清单缺失） */
export function snapshotProblems(contract: ApiContract): string[] {
  return verifyFrozenSnapshots(contract);
}

/* ------------------------------------------------------------------ */
/* 保存影响说明/迁移方案（乐观锁 + 字段级合并）                           */
/* ------------------------------------------------------------------ */

function applyFields(payload: FieldsPayload, operation: PendingOperation): ApiContract {
  const { contractId, changeId, baseValues, patch, request } = payload;
  const result = commit(operation, (contracts) => {
    const contract = mustFind(contracts, contractId);
    const applied = findAppliedOperation(contract, request.operationId);
    if (applied) {
      return contracts;
    }
    assertNotFrozen(contract);
    try {
      assertCurrentRevision(contract, request);
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        const remoteChanges = diffRemoteEdits(contract, changeId, baseValues, patch);
        throw new RevisionConflictError(contract, remoteChanges);
      }
      throw error;
    }
    const updated = bumpRevision(contract, request, {
      action: 'save_fields',
      summary: summarizeSave({ kind: 'fields', changeId, patch }),
      changeIds: [changeId],
      changes: contract.changes.map((change) =>
        change.id === changeId
          ? {
              ...mergeChangePatch(change, patch),
              reviewBasisRevision: contract.revision + 1,
              reviewBasisVersion: contract.basisVersion,
            }
          : change,
      ),
    });
    return contracts.map((item) => (item.id === contractId ? updated : item));
  });
  return mustFind(result, contractId);
}

export async function saveChangeFields(
  contractId: string,
  changeId: string,
  baseValues: Partial<Record<keyof ContractChange, string>>,
  patch: MergeableSave['patch'],
  request: RevisionRequest,
): Promise<ApiContract> {
  const payload: FieldsPayload = { contractId, changeId, baseValues, patch, request };
  const saved = applyFields(payload, {
    id: request.operationId,
    type: 'fields',
    createdAt: new Date().toISOString(),
    payload,
  });
  await wait();
  return clone(saved);
}

/* ------------------------------------------------------------------ */
/* OpenAPI 编辑                                                        */
/* ------------------------------------------------------------------ */

function applyOpenApi(payload: OpenApiPayload, operation: PendingOperation): ApiContract {
  const { contractId, openapi, request } = payload;
  const result = commit(operation, (contracts) => {
    const contract = mustFind(contracts, contractId);
    if (findAppliedOperation(contract, request.operationId)) {
      return contracts;
    }
    assertNotFrozen(contract);
    assertCurrentRevision(contract, request);
    const updated = bumpRevision(contract, request, {
      action: 'update_openapi',
      summary: `编辑契约定义（${openapi.length} 字符）`,
      changeIds: [],
      openapi,
    });
    return contracts.map((item) => (item.id === contractId ? updated : item));
  });
  return mustFind(result, contractId);
}

export async function updateContractOpenApi(
  contractId: string,
  openapi: string,
  request: RevisionRequest,
): Promise<ApiContract> {
  const payload: OpenApiPayload = { contractId, openapi, request };
  const saved = applyOpenApi(payload, {
    id: request.operationId,
    type: 'openapi',
    createdAt: new Date().toISOString(),
    payload,
  });
  await wait();
  return clone(saved);
}

/* ------------------------------------------------------------------ */
/* 单条评审                                                             */
/* ------------------------------------------------------------------ */

function applyReview(payload: ReviewPayload, operation: PendingOperation): ApiContract {
  const { contractId, changeId, state, reviewer, comment, request } = payload;
  const result = commit(operation, (contracts) => {
    const contract = mustFind(contracts, contractId);
    if (findAppliedOperation(contract, request.operationId)) {
      return contracts;
    }
    assertNotFrozen(contract);
    let conflictRemote: RemoteFieldChange[] = [];
    try {
      assertCurrentRevision(contract, request);
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        const log = [...(contract.revisionLog ?? [])].reverse().find((entry) =>
          entry.changeIds.includes(changeId),
        );
        conflictRemote = log
          ? [
              {
                changeId,
                path: contract.changes.find((c) => c.id === changeId)?.path ?? '',
                field: 'reviewState',
                label: '评审结论',
                baseValue: `修订 ${request.expectedRevision}`,
                remoteValue: `${log.action} @ 修订 ${log.revision}（${log.author}）：${log.summary}`,
                remoteAuthor: log.author,
                remoteAt: log.at,
                remoteRevision: log.revision,
              },
            ]
          : [];
        throw new RevisionConflictError(contract, conflictRemote);
      }
      throw error;
    }
    const updated = bumpRevision(contract, request, {
      action: 'review',
      summary: `${state === 'accepted' ? '接受' : state === 'returned' ? '退回' : '评审'}变更 ${changeId}`,
      changeIds: [changeId],
      status: contract.status === 'draft' ? 'review' : contract.status,
      changes: contract.changes.map((change) =>
        change.id === changeId
          ? {
              ...change,
              reviewState: state,
              reviewer,
              reviewComment: comment,
              reviewedAt: new Date().toISOString(),
              reviewBasisRevision: contract.revision + 1,
              reviewBasisVersion: contract.basisVersion,
            }
          : change,
      ),
    });
    return contracts.map((item) => (item.id === contractId ? updated : item));
  });
  return mustFind(result, contractId);
}

export async function reviewChange(
  contractId: string,
  changeId: string,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
  request: RevisionRequest,
): Promise<ApiContract> {
  const payload: ReviewPayload = {
    contractId,
    changeId,
    state: reviewState,
    reviewer,
    comment,
    request,
  };
  const saved = applyReview(payload, {
    id: request.operationId,
    type: 'review',
    createdAt: new Date().toISOString(),
    payload,
  });
  await wait();
  return clone(saved);
}

/* ------------------------------------------------------------------ */
/* 批量评审（跨契约，逐契约乐观锁）                                      */
/* ------------------------------------------------------------------ */

function applyBulkReview(payload: BulkReviewPayload, operation: PendingOperation): ApiContract[] {
  const { selections, state, reviewer, comment, bases, request } = payload;
  return commit(operation, (contracts) => {
    if (contracts.some((contract) => findAppliedOperation(contract, request.operationId))) {
      return contracts;
    }
    const byContract = new Map<string, string[]>();
    selections.forEach(({ contractId, changeId }) => {
      byContract.set(contractId, [...(byContract.get(contractId) ?? []), changeId]);
    });

    const conflicts: RemoteFieldChange[] = [];
    byContract.forEach((changeIds, contractId) => {
      const contract = contracts.find((item) => item.id === contractId);
      if (!contract) {
        return;
      }
      if (contract.status === 'frozen') {
        throw new FrozenContractError();
      }
      const base = bases[contractId];
      if (!base || base.revision !== contract.revision || base.basisVersion !== contract.basisVersion) {
        changeIds.forEach((changeId) => {
          const log = [...(contract.revisionLog ?? [])].reverse().find((entry) =>
            entry.changeIds.includes(changeId),
          );
          if (log) {
            conflicts.push({
              changeId,
              path: contract.changes.find((c) => c.id === changeId)?.path ?? '',
              field: 'reviewState',
              label: '评审结论',
              baseValue: `修订 ${base?.revision ?? '?'}`,
              remoteValue: `${log.summary}（${log.author} @ 修订 ${log.revision}）`,
              remoteAuthor: log.author,
              remoteAt: log.at,
              remoteRevision: log.revision,
            });
          }
        });
      }
    });
    if (conflicts.length) {
      throw new RevisionConflictError(contracts[0], conflicts);
    }

    const now = new Date().toISOString();
    return contracts.map((contract) => {
      const changeIds = byContract.get(contract.id);
      if (!changeIds) {
        return contract;
      }
      const picked = new Set(changeIds);
      return bumpRevision(contract, request, {
        action: 'bulk_review',
        summary: `批量${state === 'accepted' ? '接受' : '退回'} ${changeIds.length} 项变更`,
        changeIds,
        status: contract.status === 'draft' ? 'review' : contract.status,
        changes: contract.changes.map((change) =>
          picked.has(change.id)
            ? {
                ...change,
                reviewState: state,
                reviewer,
                reviewComment: comment,
                reviewedAt: now,
                reviewBasisRevision: contract.revision + 1,
                reviewBasisVersion: contract.basisVersion,
              }
            : change,
        ),
      });
    });
  });
}

export async function bulkReviewChanges(
  selections: Array<{ contractId: string; changeId: string }>,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
  bases: Record<string, { revision: number; basisVersion: string }>,
  request: RevisionRequest,
): Promise<ApiContract[]> {
  const payload: BulkReviewPayload = {
    selections,
    state: reviewState,
    reviewer,
    comment,
    bases,
    request,
  };
  const saved = applyBulkReview(payload, {
    id: request.operationId,
    type: 'bulk_review',
    createdAt: new Date().toISOString(),
    payload,
  });
  await wait();
  return clone(saved);
}

/* ------------------------------------------------------------------ */
/* 兼容层豁免（幂等：重试不重复登记）                                    */
/* ------------------------------------------------------------------ */

function applyExemption(payload: ExemptionPayload, operation: PendingOperation): ApiContract {
  const { contractId, changeId, reason, request } = payload;
  const result = commit(operation, (contracts) => {
    const contract = mustFind(contracts, contractId);
    if (findAppliedOperation(contract, request.operationId)) {
      return contracts;
    }
    assertNotFrozen(contract);
    assertCurrentRevision(contract, request);

    // 同一变更项已有豁免：直接把状态对齐为豁免，不再新增记录
    const existing = contract.exemptions.find((item) => item.changeId === changeId);
    const exemption: Exemption =
      existing ?? {
        // 确定性 id：同一操作重试不会产生第二条豁免
        id: `ex-${changeId}`,
        changeId,
        scope: contract.changes.find((item) => item.id === changeId)?.path ?? '未指定',
        reason,
        approvedBy: request.author,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
        revision: contract.revision + 1,
        basisVersion: contract.basisVersion,
      };

    const updated = bumpRevision(contract, request, {
      action: 'exemption',
      summary: existing
        ? `复用已登记豁免 ${existing.id}`
        : `登记兼容层豁免（${exemption.scope}）`,
      changeIds: [changeId],
      exemptions: existing ? contract.exemptions : [...contract.exemptions, exemption],
      changes: contract.changes.map((change) =>
        change.id === changeId
          ? {
              ...change,
              reviewState: 'exemption' as ReviewState,
              reviewBasisRevision: contract.revision + 1,
              reviewBasisVersion: contract.basisVersion,
            }
          : change,
      ),
    });
    return contracts.map((item) => (item.id === contractId ? updated : item));
  });
  return mustFind(result, contractId);
}

export async function addExemption(
  contractId: string,
  changeId: string,
  reason: string,
  request: RevisionRequest,
): Promise<ApiContract> {
  const payload: ExemptionPayload = { contractId, changeId, reason, request };
  const saved = applyExemption(payload, {
    id: request.operationId,
    type: 'exemption',
    createdAt: new Date().toISOString(),
    payload,
  });
  await wait();
  return clone(saved);
}

/* ------------------------------------------------------------------ */
/* 冻结正式版本（固化快照 + 乐观锁 + 幂等）                              */
/* ------------------------------------------------------------------ */

function applyFreeze(payload: FreezePayload, operation: PendingOperation): ApiContract {
  const { contractId, version, notes, request } = payload;
  const result = commit(operation, (contracts) => {
    const contract = mustFind(contracts, contractId);

    // 重试场景：同一次冻结已成功（operationId 命中）或该版本号已存在，
    // 幂等返回，不重复生成版本
    if (findAppliedOperation(contract, request.operationId)) {
      return contracts;
    }
    const already = contract.versions.find((item) => item.version === version);
    if (already) {
      return contracts;
    }
    if (contract.status === 'frozen') {
      throw new FrozenContractError();
    }
    assertCurrentRevision(contract, request);

    const newRevision = contract.revision + 1;
    const release: ContractVersion = {
      id: `ver-${contractId}-${version}`,
      contractId,
      version,
      releasedAt: new Date().toISOString(),
      checksum: stableChecksum(contract.openapi),
      notes,
      changeIds: contract.changes.map((change) => change.id),
      openapi: contract.openapi,
      frozenRevision: newRevision,
      // 深拷贝固化：之后工作副本任何改动都影响不到冻结版本
      frozenChanges: clone(contract.changes),
      frozenConsumers: clone(contract.consumers),
      frozenExemptions: clone(contract.exemptions),
      snapshotStatus: 'verified',
    };

    const updated = bumpRevision(
      {
        ...contract,
        version,
        status: 'frozen' as const,
        versions: [release, ...contract.versions],
        basisVersion: version,
      },
      request,
      {
        action: 'freeze',
        summary: `冻结正式版本 v${version}`,
        changeIds: release.changeIds,
      },
    );
    return contracts.map((item) => (item.id === contractId ? updated : item));
  });
  return mustFind(result, contractId);
}

export async function freezeVersion(
  contractId: string,
  version: string,
  notes: string,
  request: RevisionRequest,
): Promise<ApiContract> {
  const payload: FreezePayload = { contractId, version, notes, request };
  const saved = applyFreeze(payload, {
    id: request.operationId,
    type: 'freeze',
    createdAt: new Date().toISOString(),
    payload,
  });
  await wait();
  return clone(saved);
}

/** 冻结后基于该版本开启新一轮草稿（冻结快照保持不动） */
function applyNewDraft(payload: NewDraftPayload, operation: PendingOperation): ApiContract {
  const { contractId, nextVersion, request } = payload;
  const result = commit(operation, (items) => {
    const contract = mustFind(items, contractId);
    if (findAppliedOperation(contract, request.operationId)) {
      return items;
    }
    if (contract.status !== 'frozen') {
      throw new Error('只有已冻结契约才能开启新草稿。');
    }
    const basisVersion = contract.versions[0]?.version ?? contract.basisVersion;
    const updated = bumpRevision(
      {
        ...contract,
        status: 'draft' as const,
        version: nextVersion,
        basisVersion,
      },
      request,
      {
        action: 'new_draft',
        summary: `基于冻结版本 v${basisVersion} 开启 v${nextVersion} 草稿`,
        changeIds: [],
      },
    );
    return items.map((item) => (item.id === contractId ? updated : item));
  });
  return mustFind(result, contractId);
}

export async function startNewDraft(
  contractId: string,
  nextVersion: string,
  request: RevisionRequest,
): Promise<ApiContract> {
  const payload: NewDraftPayload = { contractId, nextVersion, request };
  const saved = applyNewDraft(payload, {
    id: request.operationId,
    type: 'new_draft',
    createdAt: new Date().toISOString(),
    payload,
  });
  await wait();
  return clone(saved);
}

/* ------------------------------------------------------------------ */
/* 新建契约（导入）                                                      */
/* ------------------------------------------------------------------ */

type NewContractInput = Omit<
  ApiContract,
  'revision' | 'basisVersion' | 'revisionLog'
> &
  Partial<Pick<ApiContract, 'revision' | 'basisVersion' | 'revisionLog'>>;

export async function saveContract(updated: NewContractInput): Promise<ApiContract> {
  const contracts = readContractsRaw();
  const now = new Date().toISOString();
  const withMeta: ApiContract = {
    ...updated,
    updatedAt: now,
    revision: typeof updated.revision === 'number' ? updated.revision : 1,
    basisVersion: updated.basisVersion ?? '',
    revisionLog:
      updated.revisionLog ??
      [
        {
          revision: 1,
          action: 'import' as const,
          author: updated.owner,
          at: now,
          summary: '导入契约创建草稿',
          changeIds: [],
          basisVersion: '',
          operationId: `import-${updated.id}`,
        },
      ],
  };
  const next = contracts.some((contract) => contract.id === updated.id)
    ? contracts.map((contract) => (contract.id === updated.id ? withMeta : contract))
    : [withMeta, ...contracts];
  try {
    persistContracts(next);
  } catch (error) {
    throw new StorageWriteError(
      {
        id: `import-${updated.id}`,
        type: 'openapi',
        createdAt: now,
        payload: {
          contractId: updated.id,
          openapi: updated.openapi,
          request: {
            expectedRevision: 0,
            expectedBasisVersion: '',
            operationId: `import-${updated.id}`,
            author: updated.owner,
          },
        },
      },
      error,
    );
  }
  await wait();
  return clone(withMeta);
}

/* ------------------------------------------------------------------ */
/* 报告与示例                                                           */
/* ------------------------------------------------------------------ */

export function generateExampleRequest(contract: ApiContract, change?: ContractChange): string {
  const view = effectiveView(contract);
  let parsed: unknown;
  try {
    parsed = JSON.parse(view.openapi);
  } catch {
    parsed = null;
  }
  const openapi = parsed as
    | {
        paths?: Record<string, Record<string, { summary?: string }>>;
      }
    | null;
  const candidates = openapi?.paths ? Object.entries(openapi.paths) : [];
  const selectedChange = change ? view.changes.find((item) => item.id === change.id) : undefined;
  const selectedPath = selectedChange?.path ?? candidates[0]?.[0] ?? '/resource';
  const selectedMethod = (
    selectedChange?.method ??
    (candidates[0]?.[1] ? Object.keys(candidates[0][1])[0] : 'get')
  ).toUpperCase();
  const fields = selectedChange
    ? [selectedChange.after.replace(/^新增|移除|变为/g, '').trim()]
    : ['orderId: ORD-20260929-001', 'requestId: req-local-demo'];

  return JSON.stringify(
    {
      method: selectedMethod,
      url: `https://api.example.com${selectedPath.replace('{orderId}', 'ORD-20260929-001').replace('{paymentId}', 'PAY-90218').replace('{userId}', 'U-1024')}`,
      headers: {
        Authorization: 'Bearer <token>',
        'X-Client-Version': view.effectiveVersion,
      },
      body:
        selectedMethod === 'GET'
          ? undefined
          : Object.fromEntries(
              fields.map((field) => {
                const [key, value] = field.split(':').map((item) => item.trim());
                return [key || 'field', value || 'value'];
              }),
            ),
    },
    null,
    2,
  );
}

export function buildChangeReport(contract: ApiContract): string {
  const view = effectiveView(contract);
  const lines = [
    `# ${contract.name} v${view.effectiveVersion} 契约变更报告`,
    '',
    `- 领域：${contract.domain}`,
    `- 负责人：${contract.owner}`,
    `- 有效版本：v${view.effectiveVersion}${view.frozen ? '（已冻结）' : '（工作副本）'}`,
    `- 修订号：r${view.revision}`,
    `- 依据版本：${view.basisVersion ? `v${view.basisVersion}` : '无（首次发布）'}`,
    `- 校验值：${view.checksum}${view.frozenVersion?.snapshotStatus === 'legacy' ? '（历史快照）' : ''}`,
    `- 状态：${contract.status}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 变更明细',
    ...view.changes.flatMap((change) => [
      `### ${change.method} ${change.path} - ${change.kind}`,
      `- 兼容性：${change.compatibility}`,
      `- 变更前：${change.before}`,
      `- 变更后：${change.after}`,
      `- 判定依据：${change.rationale}`,
      `- 调用方影响：${change.impactStatement || '未填写'}`,
      `- 迁移方案：${change.migrationPlan || '未填写'}`,
      `- 评审结论：${change.reviewState}`,
      `- 审核依据：${change.reviewBasisRevision ? `r${change.reviewBasisRevision}` : '历史数据迁移补齐'} / ${change.reviewBasisVersion ? `v${change.reviewBasisVersion}` : '首次发布'}`,
      '',
    ]),
    '## 调用方',
    ...view.consumers.map(
      (consumer) =>
        `- ${consumer.name} / ${consumer.owner} / ${consumer.environment} / ${consumer.clientVersion}`,
    ),
    '',
    '## 豁免记录',
    ...(view.exemptions.length
      ? view.exemptions.map(
          (item) =>
            `- ${item.scope}：${item.reason}（至 ${item.expiresAt}，登记于 r${item.revision}，依据 v${item.basisVersion || '首次发布'}）`,
        )
      : ['- 无']),
  ];
  return lines.join('\n');
}

export function diffVersionSummary(contract: ApiContract): string {
  const view = effectiveView(contract);
  const previous = contract.versions[0];
  if (!previous) {
    return '无可比较的历史正式版本。';
  }
  return [
    `有效版本：v${view.effectiveVersion}（修订 r${view.revision}）`,
    `上一版 v${previous.version}`,
    `发布于 ${formatDateTime(previous.releasedAt)}`,
    `校验值 ${previous.checksum}${previous.snapshotStatus === 'legacy' ? '（历史快照）' : ''}`,
    `固化修订 r${previous.frozenRevision || '迁移补齐'}`,
    `本版变更 ${view.changes.length} 项`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

function mustFind(contracts: ApiContract[], id: string): ApiContract {
  const contract = contracts.find((item) => item.id === id);
  if (!contract) {
    throw new Error('契约不存在');
  }
  return contract;
}

function bumpRevision(
  contract: ApiContract,
  request: RevisionRequest,
  input: {
    action: RevisionLogEntry['action'];
    summary: string;
    changeIds: string[];
  } & Partial<Omit<ApiContract, 'revisionLog'>>,
): ApiContract {
  const { action, summary, changeIds, ...patch } = input;
  const base: ApiContract = {
    ...contract,
    ...patch,
    revision: contract.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  base.revisionLog = appendLog(contract, {
    action,
    author: request.author,
    summary,
    changeIds,
    operationId: request.operationId,
  });
  return base;
}

export { FrozenSnapshotError };
