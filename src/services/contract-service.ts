import { seedContracts } from '../data/seed';
import type {
  ApiContract,
  ContractChange,
  ContractVersion,
  ReviewState,
} from '../models/contract';
import { formatDateTime } from '../lib/utils';
import {
  assertFrozenFieldsUntouched,
  assertWritable,
  bumpRevision,
  effectiveView,
  exemptionIdFromRequest,
  FrozenContractError,
  InvalidRevisionError,
  migrateContract,
  nowIso,
  releaseIssues,
  remoteRevisionsSince,
  requestId as newRequestId,
  RevisionConflictError,
  snapshotChecksum,
  threeWayMerge,
  versionIdFromRequest,
  type FieldConflict,
  type RemoteRevision,
} from '../models/revision-engine';
import { validateForRelease } from '../models/contract';

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const META_KEY = 'pair-wise-gsb-70-write-meta';
const LATENCY = 180;

export interface WriteEnvelope {
  contracts: ApiContract[];
  schemaVersion: number;
}

export interface PendingWrite {
  id: string;
  contractId: string;
  kind:
    | 'save'
    | 'openapi'
    | 'review'
    | 'bulk_review'
    | 'exemption'
    | 'freeze'
    | 'start_draft';
  requestId: string;
  actor: string;
  payload: unknown;
  baseRevision?: number;
  createdAt: string;
  lastError?: string;
  attempts: number;
}

interface WriteMeta {
  failNextWrites: boolean;
  pending: PendingWrite[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

// ---------------------------------------------------------------------------
// 底层存储（同步，模拟 localStorage 后端；可注入失败用于演示待恢复批次）
// ---------------------------------------------------------------------------

function readMeta(): WriteMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WriteMeta>;
      return {
        failNextWrites: !!parsed.failNextWrites,
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      };
    }
  } catch {
    // 忽略损坏的元数据
  }
  return { failNextWrites: false, pending: [] };
}

function writeMeta(meta: WriteMeta): void {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function simulateWriteFailure(): boolean {
  const meta = readMeta();
  return meta.failNextWrites;
}

export function setFailNextWrites(enabled: boolean): void {
  const meta = readMeta();
  meta.failNextWrites = enabled;
  writeMeta(meta);
}

function persistContracts(contracts: ApiContract[]): void {
  if (simulateWriteFailure()) {
    throw new Error('模拟写入失败：本地存储暂不可用，改动已保留到待恢复批次。');
  }
  const envelope: WriteEnvelope = {
    contracts,
    schemaVersion: 2,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
}

function persistPending(pending: PendingWrite[]): void {
  // 待恢复批次即使在故障开关开启时也必须落盘
  const meta = readMeta();
  meta.pending = pending;
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function readEnvelope(): { list: unknown[]; isLegacy: boolean; schemaVersion?: number } {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return { list: [], isLegacy: false };
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return { list: parsed, isLegacy: true };
    if (parsed && Array.isArray(parsed.contracts)) {
      return {
        list: parsed.contracts,
        isLegacy: (parsed.schemaVersion ?? 1) < 2,
        schemaVersion: parsed.schemaVersion,
      };
    }
    return { list: [], isLegacy: false };
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return { list: [], isLegacy: false };
  }
}

function readContractsRaw(): ApiContract[] {
  const { list, isLegacy } = readEnvelope();
  const migrated = list
    .map(migrateContract)
    .filter((item): item is ApiContract => item !== null);
  // 旧数据首次打开：迁移补齐修订号与审核依据后回写一次（失败则下次再试）
  if (isLegacy && migrated.length) {
    try {
      persistContracts(migrated);
    } catch {
      // 存储不可用时仍返回迁移后的内存数据，待恢复批次由具体写入路径处理
    }
  }
  return migrated;
}

function loadContracts(): ApiContract[] {
  const contracts = readContractsRaw();
  if (!contracts.length) {
    const hasKey = localStorage.getItem(STORAGE_KEY) !== null;
    if (!hasKey) {
      const seeded = seedContracts.map((contract) => migrateContract(contract)!) as ApiContract[];
      persistContracts(seeded);
      return seeded;
    }
  }
  return contracts;
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait();
  return clone(loadContracts());
}

export async function getContract(id: string): Promise<ApiContract | undefined> {
  const contracts = loadContracts();
  return clone(contracts.find((contract) => contract.id === id));
}

function findContract(contracts: ApiContract[], contractId: string): ApiContract {
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) throw new Error('契约不存在');
  return contract;
}

function replaceContract(contracts: ApiContract[], updated: ApiContract): ApiContract[] {
  return contracts.map((item) => (item.id === updated.id ? updated : item));
}

// ---------------------------------------------------------------------------
// 待恢复批次
// ---------------------------------------------------------------------------

export function listPendingWrites(): PendingWrite[] {
  return readMeta().pending;
}

function enqueuePending(entry: Omit<PendingWrite, 'id' | 'createdAt' | 'attempts'>): PendingWrite {
  const pending = listPendingWrites();
  const write: PendingWrite = {
    ...entry,
    id: `pending-${newRequestId()}`,
    createdAt: nowIso(),
    attempts: 0,
  };
  pending.push(write);
  persistPending(pending);
  return write;
}

function updatePending(id: string, patch: Partial<PendingWrite>): void {
  const pending = listPendingWrites().map((item) =>
    item.id === id ? { ...item, ...patch } : item,
  );
  persistPending(pending);
}

function removePending(id: string): void {
  persistPending(listPendingWrites().filter((item) => item.id !== id));
}

export function discardPendingWrite(id: string): void {
  removePending(id);
}

/** 执行一次“读取-改动-写入”，失败时保留到待恢复批次 */
async function commitWrite<T>(input: {
  pendingId?: string;
  enqueue?: Omit<PendingWrite, 'id' | 'createdAt' | 'attempts'>;
  run: () => T;
}): Promise<T> {
  let result: T;
  try {
    result = input.run();
  } catch (error) {
    // 冲突 / 冻结 / 参数错误属于业务拒绝，不是写入失败，不入队
    if (
      error instanceof RevisionConflictError ||
      error instanceof FrozenContractError ||
      error instanceof InvalidRevisionError
    ) {
      throw error;
    }
    if (input.pendingId) {
      updatePending(input.pendingId, {
        lastError: error instanceof Error ? error.message : String(error),
      });
    } else if (input.enqueue) {
      enqueuePending(input.enqueue);
    }
    throw error;
  }
  if (input.pendingId) removePending(input.pendingId);
  await wait();
  return result;
}

// ---------------------------------------------------------------------------
// 冲突构造
// ---------------------------------------------------------------------------

function buildConflict(
  baseContract: ApiContract,
  current: ApiContract,
  conflicts: FieldConflict[],
): RevisionConflictError {
  return new RevisionConflictError({
    expectedRevision: baseContract.revision,
    currentRevision: current.revision,
    basisVersion: current.basisVersion,
    remoteRevisions: remoteRevisionsSince(current, baseContract.revision),
    conflicts,
  });
}

// ---------------------------------------------------------------------------
// 保存（乐观并发 + 三方合并）
// ---------------------------------------------------------------------------

type MergeField = FieldConflict['field'];

export interface SaveContractInput {
  contract: ApiContract;
  expectedRevision: number;
  baseContract?: ApiContract;
  actor?: string;
  /** 冲突字段上用户已选择采用本地值时传入 */
  resolveWithMine?: MergeField[];
  requestIdValue?: string;
}

/** 合并草稿/评审页保存：只接收基于当前修订的改动，冲突先列出对方变更 */
export async function saveContract(input: SaveContractInput): Promise<ApiContract> {
  const requestIdValue = input.requestIdValue ?? newRequestId();
  return commitWrite({
    enqueue: {
      contractId: input.contract.id,
      kind: 'save',
      requestId: requestIdValue,
      actor: input.actor ?? '当前维护者',
      payload: {
        contract: input.contract,
        baseContract: input.baseContract,
        resolveWithMine: input.resolveWithMine ?? [],
      },
      baseRevision: input.expectedRevision,
    },
    run: () => {
      const contracts = loadContracts();
      const current = contracts.find((item) => item.id === input.contract.id);

      // 新建契约：本地尚不存在时直接插入，不做并发合并
      if (!current) {
        const inserted = migrateContract(input.contract) ?? input.contract;
        persistContracts([inserted, ...contracts]);
        return clone(inserted);
      }

      assertWritable(current);
      assertFrozenFieldsUntouched(current, input.contract);

      let candidate: ApiContract;
      if (input.expectedRevision === current.revision) {
        candidate = { ...current, ...pickEditable(input.contract) };
      } else {
        const base = input.baseContract
          ? migrateContract(input.baseContract)!
          : reconstructBase(current, input.expectedRevision);
        const { merged, conflicts } = threeWayMerge(base, current, input.contract);
        if (conflicts.length) {
          const unresolved = input.resolveWithMine ?? [];
          const remaining = conflicts.filter((conflict) => !unresolved.includes(conflict.field));
          if (remaining.length) {
            throw buildConflict(base, current, remaining);
          }
          // 已确认的冲突字段采用本地值
          for (const conflict of conflicts) {
            if (unresolved.includes(conflict.field)) applyMineResolution(merged, conflict, input.contract);
          }
        }
        candidate = { ...current, ...pickEditable(merged) };
      }

      const next = bumpRevision(current, {
        actor: input.actor ?? '当前维护者',
        action: 'draft_save',
        summary:
          input.expectedRevision === current.revision
            ? describeSave(current, candidate)
            : `合并两个评审会话的改动（对方修订 ${current.revision} → ${current.revision + 1}）`,
        requestId: requestIdValue,
        newState: candidate,
      });
      const finalContract: ApiContract = { ...next, ...pickEditable(candidate) };

      persistContracts(replaceContract(contracts, finalContract));
      return clone(finalContract);
    },
  });
}

function pickEditable(source: ApiContract) {
  return {
    name: source.name,
    domain: source.domain,
    owner: source.owner,
    openapi: source.openapi,
    changes: source.changes,
    consumers: source.consumers,
    exemptions: source.exemptions,
  };
}

function applyMineResolution(
  merged: ApiContract,
  conflict: FieldConflict,
  mine: ApiContract,
): void {
  if (conflict.field === 'openapi') merged.openapi = mine.openapi;
  if (conflict.field === 'name') merged.name = mine.name;
  if (conflict.field === 'domain') merged.domain = mine.domain;
  if (conflict.field === 'owner') merged.owner = mine.owner;
  if (conflict.field.startsWith('change:')) {
    const [, changeId, key] = conflict.field.split(':');
    const change = mine.changes.find((item) => item.id === changeId);
    if (change) {
      merged.changes = merged.changes.map((item) =>
        item.id === changeId
          ? ({ ...item, [key]: (change as unknown as Record<string, unknown>)[key] } as ContractChange)
          : item,
      );
    }
  }
  if (conflict.field.startsWith('consumer:')) {
    const consumerId = conflict.field.split(':')[1];
    const consumer = mine.consumers.find((item) => item.id === consumerId);
    if (consumer) {
      merged.consumers = merged.consumers.map((item) =>
        item.id === consumerId ? consumer : item,
      );
    }
  }
}

function reconstructBase(contract: ApiContract, expectedRevision: number): ApiContract {
  // 无法拿到对方快照时，退化为以当前服务端作为祖先：只有本地字段与服务端不同才算改动
  const base = structuredClone(contract);
  base.revision = expectedRevision;
  return base;
}

function describeSave(before: ApiContract, after: ApiContract): string {
  if (before.openapi !== after.openapi) return '更新了 OpenAPI 契约定义';
  const edited = after.changes.filter((change) => {
    const previous = before.changes.find((item) => item.id === change.id);
    return (
      previous &&
      (previous.impactStatement !== change.impactStatement ||
        previous.migrationPlan !== change.migrationPlan)
    );
  }).length;
  if (edited) return `补充了 ${edited} 项变更的影响说明或迁移方案`;
  return '保存了契约草稿改动';
}

// ---------------------------------------------------------------------------
// 评审记录
// ---------------------------------------------------------------------------

export interface ReviewInput {
  contractId: string;
  changeId: string;
  reviewState: ReviewState;
  reviewer: string;
  comment: string;
  expectedRevision: number;
  requestIdValue?: string;
}

export async function reviewChange(input: ReviewInput): Promise<ApiContract> {
  const requestIdValue = input.requestIdValue ?? newRequestId();
  return commitWrite({
    enqueue: {
      contractId: input.contractId,
      kind: 'review',
      requestId: requestIdValue,
      actor: input.reviewer,
      payload: input,
      baseRevision: input.expectedRevision,
    },
    run: () => {
      const contracts = loadContracts();
      const current = findContract(contracts, input.contractId);
      assertWritable(current);

      const applyReview = (contract: ApiContract): ApiContract => {
        const reviewedChanges = contract.changes.map((change) =>
          change.id === input.changeId
            ? {
                ...change,
                reviewState: input.reviewState,
                reviewer: input.reviewer,
                reviewComment: input.comment,
                reviewedAt: nowIso(),
              }
            : change,
        );
        const bumped = bumpRevision(contract, {
          actor: input.reviewer,
          action: 'review',
          summary: `${changeLabel(contract, input.changeId)} 评审为 ${input.reviewState}`,
          requestId: requestIdValue,
          newState: { openapi: contract.openapi, changes: reviewedChanges },
        });
        return {
          ...bumped,
          status: contract.status === 'draft' ? 'review' : contract.status,
          changes: bumped.changes.map((change) =>
            change.id === input.changeId
              ? {
                  ...change,
                  basisRevision: bumped.revision,
                  basisSemanticRevision: bumped.semanticRevision,
                  basisVersion: bumped.basisVersion || undefined,
                }
              : change,
          ),
        };
      };

      // 幂等：同一评审请求重试，直接返回当前结果
      if (current.revisionLog.some((entry) => entry.requestId === requestIdValue)) {
        return clone(current);
      }

      if (input.expectedRevision !== current.revision) {
        // 补丁操作默认基于最新修订应用；若对方已经对同一条变更给出不同结论，先返回冲突
        const target = current.changes.find((change) => change.id === input.changeId);
        if (
          target &&
          target.reviewState !== 'pending' &&
          target.reviewState !== input.reviewState
        ) {
          throw buildConflict(
            reconstructBase(current, input.expectedRevision),
            current,
            [
              {
                field: `change:${input.changeId}:reviewState`,
                label: `${target.method} ${target.path} · 评审结论`,
                base: 'pending',
                theirs: target.reviewState,
                mine: input.reviewState,
                changeId: input.changeId,
              },
            ],
          );
        }
      }

      const next = applyReview(current);
      persistContracts(replaceContract(contracts, next));
      return clone(next);
    },
  });
}

function changeLabel(contract: ApiContract, changeId: string): string {
  const change = contract.changes.find((item) => item.id === changeId);
  return change ? `${change.method} ${change.path}` : changeId;
}

export interface BulkReviewInput {
  selections: Array<{ contractId: string; changeId: string }>;
  reviewState: ReviewState;
  reviewer: string;
  comment: string;
  expectedRevisions: Record<string, number>;
  requestIdValue?: string;
}

export async function bulkReviewChanges(input: BulkReviewInput): Promise<ApiContract[]> {
  const requestIdValue = input.requestIdValue ?? newRequestId();
  return commitWrite({
    enqueue: {
      contractId: input.selections[0]?.contractId ?? '',
      kind: 'bulk_review',
      requestId: requestIdValue,
      actor: input.reviewer,
      payload: input,
      baseRevision: input.selections[0] ? input.expectedRevisions[input.selections[0].contractId] : undefined,
    },
    run: () => {
      const contracts = loadContracts();
      const selected = new Set(input.selections.map((item) => `${item.contractId}:${item.changeId}`));
      const updated = contracts.map((contract) => {
        if (!input.selections.some((item) => item.contractId === contract.id)) {
          return contract;
        }
        if (contract.status === 'frozen') return contract;
        if (
          contract.revisionLog.some((entry) => entry.requestId === requestIdValue)
        ) {
          return contract;
        }
        const reviewedChanges = contract.changes.map((change) =>
          selected.has(`${contract.id}:${change.id}`)
            ? {
                ...change,
                reviewState: input.reviewState,
                reviewer: input.reviewer,
                reviewComment: input.comment,
                reviewedAt: nowIso(),
              }
            : change,
        );
        const bumped = bumpRevision(contract, {
          actor: input.reviewer,
          action: 'bulk_review',
          summary: `批量评审 ${input.selections.filter((item) => item.contractId === contract.id).length} 项为 ${input.reviewState}`,
          requestId: requestIdValue,
          newState: { openapi: contract.openapi, changes: reviewedChanges },
        });
        return {
          ...bumped,
          status: contract.status === 'draft' ? 'review' : contract.status,
          changes: bumped.changes.map((change) =>
            selected.has(`${contract.id}:${change.id}`)
              ? {
                  ...change,
                  basisRevision: bumped.revision,
                  basisSemanticRevision: bumped.semanticRevision,
                  basisVersion: bumped.basisVersion || undefined,
                }
              : change,
          ),
        };
      });
      persistContracts(updated);
      return clone(updated);
    },
  });
}

// ---------------------------------------------------------------------------
// OpenAPI 定义编辑
// ---------------------------------------------------------------------------

export interface UpdateOpenApiInput {
  contractId: string;
  openapi: string;
  expectedRevision: number;
  actor?: string;
  requestIdValue?: string;
}

export async function updateContractOpenApi(input: UpdateOpenApiInput): Promise<ApiContract> {
  const requestIdValue = input.requestIdValue ?? newRequestId();
  return commitWrite({
    enqueue: {
      contractId: input.contractId,
      kind: 'openapi',
      requestId: requestIdValue,
      actor: input.actor ?? '当前维护者',
      payload: input,
      baseRevision: input.expectedRevision,
    },
    run: () => {
      const contracts = loadContracts();
      const current = findContract(contracts, input.contractId);
      assertWritable(current);

      if (current.revisionLog.some((entry) => entry.requestId === requestIdValue)) {
        return clone(current);
      }

      if (input.expectedRevision !== current.revision) {
        throw buildConflict(
          reconstructBase(current, input.expectedRevision),
          current,
          current.openapi === input.openapi
            ? []
            : [
                {
                  field: 'openapi',
                  label: 'OpenAPI 定义',
                  base: '（你打开时的版本）',
                  theirs: current.openapi.slice(0, 120),
                  mine: input.openapi.slice(0, 120),
                },
              ],
        );
      }

      const next = bumpRevision(current, {
        actor: input.actor ?? '当前维护者',
        action: 'openapi_edit',
        summary: '编辑了 OpenAPI 契约定义',
        requestId: requestIdValue,
        newState: { openapi: input.openapi, changes: current.changes },
      });
      persistContracts(replaceContract(contracts, next));
      return clone(next);
    },
  });
}

// ---------------------------------------------------------------------------
// 豁免（幂等，重试不重复登记）
// ---------------------------------------------------------------------------

export interface ExemptionInput {
  contractId: string;
  changeId: string;
  reason: string;
  expectedRevision: number;
  approvedBy?: string;
  requestIdValue?: string;
}

export async function addExemption(input: ExemptionInput): Promise<ApiContract> {
  const requestIdValue = input.requestIdValue ?? newRequestId();
  const exemptionId = exemptionIdFromRequest(requestIdValue);
  return commitWrite({
    enqueue: {
      contractId: input.contractId,
      kind: 'exemption',
      requestId: requestIdValue,
      actor: input.approvedBy ?? '当前评审人',
      payload: { ...input, requestIdValue },
      baseRevision: input.expectedRevision,
    },
    run: () => {
      const contracts = loadContracts();
      const current = findContract(contracts, input.contractId);

      // 幂等检查先于冻结校验：同一豁免请求重试直接返回，不重复生成豁免
      const existing = current.exemptions.find(
        (item) => item.requestId === requestIdValue || item.id === exemptionId,
      );
      if (existing) {
        return clone(current);
      }

      assertWritable(current);

      // 对方已在最新修订登记了同一变更的豁免：不重复生成
      if (
        current.exemptions.some((item) => item.changeId === input.changeId && !item.frozenInVersion)
      ) {
        return clone(current);
      }

      const targetChange = current.changes.find((item) => item.id === input.changeId);
      const exemption = {
        id: exemptionId,
        changeId: input.changeId,
        scope: targetChange?.path ?? '未指定',
        reason: input.reason,
        approvedBy: input.approvedBy ?? '当前评审人',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        requestId: requestIdValue,
        basisRevision: current.revision + 1,
      };
      const exemptionChanges = current.changes.map((change) =>
        change.id === input.changeId
          ? {
              ...change,
              reviewState: 'exemption' as const,
              reviewer: exemption.approvedBy,
              reviewComment: input.reason,
              reviewedAt: nowIso(),
            }
          : change,
      );
      const bumped = bumpRevision(current, {
        actor: exemption.approvedBy,
        action: 'exemption',
        summary: `为 ${changeLabel(current, input.changeId)} 登记兼容层豁免`,
        requestId: requestIdValue,
        newState: { openapi: current.openapi, changes: exemptionChanges },
      });
      bumped.exemptions = [...current.exemptions, exemption];
      bumped.changes = bumped.changes.map((change) =>
        change.id === input.changeId
          ? {
              ...change,
              basisRevision: bumped.revision,
              basisSemanticRevision: bumped.semanticRevision,
              basisVersion: bumped.basisVersion || undefined,
            }
          : change,
      );
      persistContracts(replaceContract(contracts, bumped));
      return clone(bumped);
    },
  });
}

// ---------------------------------------------------------------------------
// 冻结正式版本（固化 + 幂等 + 门禁）
// ---------------------------------------------------------------------------

export interface FreezeInput {
  contractId: string;
  version: string;
  notes: string;
  expectedRevision: number;
  actor?: string;
  requestIdValue?: string;
}

export async function freezeVersion(input: FreezeInput): Promise<ApiContract> {
  const requestIdValue = input.requestIdValue ?? newRequestId();
  const releaseId = versionIdFromRequest(input.contractId, requestIdValue);
  return commitWrite({
    enqueue: {
      contractId: input.contractId,
      kind: 'freeze',
      requestId: requestIdValue,
      actor: input.actor ?? '发布负责人',
      payload: { ...input, requestIdValue },
      baseRevision: input.expectedRevision,
    },
    run: () => {
      const contracts = loadContracts();
      const current = findContract(contracts, input.contractId);

      // 幂等检查必须先于冻结/修订校验：重试同一冻结请求直接返回，不重复生成版本
      const existingRelease = current.versions.find(
        (version) => version.id === releaseId || version.version === input.version,
      );
      if (existingRelease) {
        return clone(current);
      }

      assertWritable(current);

      if (input.expectedRevision !== current.revision) {
        throw buildConflict(reconstructBase(current, input.expectedRevision), current, []);
      }

      const baseIssues = validateForRelease(current);
      const issues = releaseIssues(current, baseIssues).filter(
        (issue) => issue.severity === 'blocker',
      );
      if (issues.length) {
        throw new Error(`发布门禁未通过：${issues[0].title} - ${issues[0].detail}`);
      }

      const frozenChanges = current.changes.map((change) =>
        change.reviewState !== 'pending'
          ? { ...change, frozenInVersion: input.version }
          : change,
      );
      const frozenExemptions = current.exemptions.map((exemption) => ({
        ...exemption,
        frozenInVersion: input.version,
      }));
      const checksum = snapshotChecksum({
        openapi: current.openapi,
        changes: frozenChanges,
        consumers: current.consumers,
        exemptions: frozenExemptions,
      });

      const release: ContractVersion = {
        id: releaseId,
        contractId: input.contractId,
        version: input.version,
        releasedAt: nowIso(),
        checksum,
        notes: input.notes,
        changeIds: frozenChanges.map((change) => change.id),
        openapi: current.openapi,
        changes: frozenChanges,
        consumers: clone(current.consumers),
        exemptions: frozenExemptions,
        revision: current.revision,
        semanticRevision: current.semanticRevision,
        basisVersion: current.basisVersion || undefined,
      };

      const bumped = bumpRevision(current, {
        actor: input.actor ?? '发布负责人',
        action: 'freeze',
        summary: `冻结正式版本 v${input.version}（校验值 ${checksum}）`,
        requestId: requestIdValue,
      });
      const next: ApiContract = {
        ...bumped,
        version: input.version,
        status: 'frozen',
        basisVersion: input.version,
        versions: [release, ...bumped.versions],
        changes: frozenChanges,
        exemptions: frozenExemptions,
      };
      persistContracts(replaceContract(contracts, next));
      return clone(next);
    },
  });
}

// ---------------------------------------------------------------------------
// 冻结后基于新版本发起草稿
// ---------------------------------------------------------------------------

export interface StartDraftInput {
  contractId: string;
  actor?: string;
  expectedRevision?: number;
  requestIdValue?: string;
}

export async function startNewDraft(input: StartDraftInput): Promise<ApiContract> {
  const requestIdValue = input.requestIdValue ?? newRequestId();
  return commitWrite({
    enqueue: {
      contractId: input.contractId,
      kind: 'start_draft',
      requestId: requestIdValue,
      actor: input.actor ?? '当前维护者',
      payload: input,
      baseRevision: input.expectedRevision,
    },
    run: () => {
      const contracts = loadContracts();
      const current = findContract(contracts, input.contractId);
      if (current.status !== 'frozen') {
        throw new InvalidRevisionError('只有已冻结契约才能发起新一版草稿。');
      }
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== current.revision
      ) {
        throw buildConflict(reconstructBase(current, input.expectedRevision), current, []);
      }
      const bumped = bumpRevision(current, {
        actor: input.actor ?? '当前维护者',
        action: 'start_draft',
        summary: `基于 v${current.version} 发起新一版草稿，冻结内容保持只读`,
        requestId: requestIdValue,
      });
      const next: ApiContract = {
        ...bumped,
        status: 'draft',
        changes: bumped.changes.map((change) => ({
          ...change,
          frozenInVersion: undefined,
          // 新草稿尚未重新评审
          reviewState: 'pending',
          reviewer: '',
          reviewComment: '',
          reviewedAt: undefined,
          basisRevision: undefined,
          basisSemanticRevision: undefined,
          basisVersion: current.version,
        })),
        exemptions: bumped.exemptions
          .filter((exemption) => !exemption.frozenInVersion)
          .map((exemption) => ({ ...exemption, frozenInVersion: undefined })),
      };
      persistContracts(replaceContract(contracts, next));
      return clone(next);
    },
  });
}

// ---------------------------------------------------------------------------
// 待恢复批次重放（重试不会重复生成版本或豁免）
// ---------------------------------------------------------------------------

export interface ReplayResult {
  succeeded: PendingWrite[];
  failed: Array<{ write: PendingWrite; error: string }>;
}

export async function replayPendingWrites(): Promise<ReplayResult> {
  const pending = listPendingWrites();
  const succeeded: PendingWrite[] = [];
  const failed: Array<{ write: PendingWrite; error: string }> = [];

  for (const write of pending) {
    try {
      await replayOne(write);
      succeeded.push(write);
      removePending(write.id);
    } catch (error) {
      const message =
        error instanceof RevisionConflictError
          ? `合并冲突：对方已更新到修订 ${error.currentRevision}，请打开冲突确认。`
          : error instanceof Error
            ? error.message
            : String(error);
      updatePending(write.id, { attempts: write.attempts + 1, lastError: message });
      failed.push({ write, error: message });
    }
  }
  await wait();
  return { succeeded, failed };
}

async function replayOne(write: PendingWrite): Promise<unknown> {
  switch (write.kind) {
    case 'save': {
      const payload = write.payload as {
        contract: ApiContract;
        baseContract?: ApiContract;
        resolveWithMine: MergeField[];
      };
      return saveContract({
        contract: payload.contract,
        baseContract: payload.baseContract,
        resolveWithMine: payload.resolveWithMine,
        expectedRevision: write.baseRevision ?? payload.contract.revision,
        actor: write.actor,
        requestIdValue: write.requestId,
      });
    }
    case 'openapi':
      return updateContractOpenApi({
        ...(write.payload as Omit<UpdateOpenApiInput, 'requestIdValue'>),
        requestIdValue: write.requestId,
      });
    case 'review':
      return reviewChange({
        ...(write.payload as Omit<ReviewInput, 'requestIdValue'>),
        requestIdValue: write.requestId,
      });
    case 'bulk_review':
      return bulkReviewChanges({
        ...(write.payload as Omit<BulkReviewInput, 'requestIdValue'>),
        requestIdValue: write.requestId,
      });
    case 'exemption':
      return addExemption({
        ...(write.payload as Omit<ExemptionInput, 'requestIdValue'>),
        requestIdValue: write.requestId,
      });
    case 'freeze':
      return freezeVersion({
        ...(write.payload as Omit<FreezeInput, 'requestIdValue'>),
        requestIdValue: write.requestId,
      });
    case 'start_draft':
      return startNewDraft({
        ...(write.payload as Omit<StartDraftInput, 'requestIdValue'>),
        requestIdValue: write.requestId,
      });
  }
}

// ---------------------------------------------------------------------------
// 报告与示例（使用有效视图）
// ---------------------------------------------------------------------------

export function generateExampleRequest(viewContract: ApiContract, change?: ContractChange): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(viewContract.openapi);
  } catch {
    parsed = null;
  }
  const openapi = parsed as
    | {
        paths?: Record<string, Record<string, { summary?: string }>>;
      }
    | null;
  const candidates = openapi?.paths ? Object.entries(openapi.paths) : [];
  const selectedPath = change?.path ?? candidates[0]?.[0] ?? '/resource';
  const selectedMethod = (
    change?.method ??
    (candidates[0]?.[1] ? Object.keys(candidates[0][1])[0] : 'get')
  ).toUpperCase();
  const fields = change
    ? [change.after.replace(/^新增|移除|变为/g, '').trim()]
    : ['orderId: ORD-20260929-001', 'requestId: req-local-demo'];

  return JSON.stringify(
    {
      method: selectedMethod,
      url: `https://api.example.com${selectedPath.replace('{orderId}', 'ORD-20260929-001').replace('{paymentId}', 'PAY-90218').replace('{userId}', 'U-1024')}`,
      headers: {
        Authorization: 'Bearer <token>',
        'X-Client-Version': viewContract.version,
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

export function buildChangeReport(viewContract: ApiContract, working?: ApiContract): string {
  const effective = working ? effectiveView(working).contract : viewContract;
  const latest = effective.versions[0];
  const lines = [
    `# ${effective.name} ${effective.version} 契约变更报告`,
    '',
    `- 领域：${effective.domain}`,
    `- 负责人：${effective.owner}`,
    `- 状态：${effective.status}`,
    `- 当前有效版本：v${effective.version}`,
    `- 工作副本修订号：${working?.revision ?? effective.revision}`,
    `- 语义修订号：${working?.semanticRevision ?? effective.semanticRevision}`,
    `- 依据版本：${working?.basisVersion || latest?.version || '无（首次发布）'}`,
    latest
      ? `- 冻结校验值：${latest.checksum}（${latest.migrated ? '历史版本迁移补建' : '完整固化快照'}）`
      : '- 冻结校验值：无（尚未冻结）',
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 变更明细',
    ...effective.changes.flatMap((change) => [
      `### ${change.method} ${change.path} - ${change.kind}`,
      `- 兼容性：${change.compatibility}`,
      `- 变更前：${change.before}`,
      `- 变更后：${change.after}`,
      `- 判定依据：${change.rationale}`,
      `- 调用方影响：${change.impactStatement || '未填写'}`,
      `- 迁移方案：${change.migrationPlan || '未填写'}`,
      `- 评审结论：${change.reviewState}`,
      `- 审核依据：修订 ${change.basisRevision ?? '未记录'} / 语义修订 ${change.basisSemanticRevision ?? '未记录'} / 版本 ${change.basisVersion || '未记录'}`,
      change.frozenInVersion ? `- 已固化版本：v${change.frozenInVersion}` : null,
      '',
    ].filter((line): line is string => line !== null)),
    '## 调用方',
    ...effective.consumers.map(
      (consumer) =>
        `- ${consumer.name} / ${consumer.owner} / ${consumer.environment} / ${consumer.clientVersion}`,
    ),
    '',
    '## 豁免记录',
    ...(effective.exemptions.length
      ? effective.exemptions.map(
          (item) =>
            `- ${item.scope}：${item.reason}（${item.approvedBy} 批准，至 ${item.expiresAt}${item.frozenInVersion ? `，已固化进 v${item.frozenInVersion}` : ''}）`,
        )
      : ['- 无']),
  ];
  return lines.join('\n');
}

export function diffVersionSummary(working: ApiContract): string {
  const previous = working.versions[0];
  if (!previous) {
    return '无可比较的历史正式版本。';
  }
  return [
    `上一版 ${previous.version}`,
    `发布于 ${formatDateTime(previous.releasedAt)}`,
    `校验值 ${previous.checksum}${previous.migrated ? '（历史迁移补建）' : ''}`,
    `冻结时修订 ${previous.revision}`,
    `本版变更 ${working.changes.length} 项`,
  ].join('\n');
}

export { effectiveView, releaseIssues };
export type { RemoteRevision };
