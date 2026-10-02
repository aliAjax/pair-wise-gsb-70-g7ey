import type {
  ApiConsumer,
  ApiContract,
  ContractChange,
  Exemption,
  ReleaseIssue,
  RevisionLog,
} from './contract';

/** 旧数据首次打开时的存储版本号 */
export const SCHEMA_VERSION = 2;

export type MergeField =
  | 'openapi'
  | 'name'
  | 'domain'
  | 'owner'
  | `change:${string}:${keyof ContractChange}`
  | `consumer:${string}`
  | 'exemption'
  | 'status';

export interface FieldConflict {
  field: MergeField;
  label: string;
  base: string;
  theirs: string;
  mine: string;
  /** 冲突涉及的变更 id（可选） */
  changeId?: string;
}

export interface RemoteRevision {
  revision: number;
  at: string;
  actor: string;
  action: RevisionLog['action'];
  summary: string;
  basisVersion?: string;
}

export class RevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly basisVersion: string;
  readonly remoteRevisions: RemoteRevision[];
  readonly conflicts: FieldConflict[];

  constructor(input: {
    expectedRevision: number;
    currentRevision: number;
    basisVersion: string;
    remoteRevisions: RemoteRevision[];
    conflicts: FieldConflict[];
  }) {
    super(
      `契约已被其他评审会话更新到修订号 ${input.currentRevision}（你当前基于 ${input.expectedRevision}），请先查看对方变更再合并。`,
    );
    this.name = 'RevisionConflictError';
    this.expectedRevision = input.expectedRevision;
    this.currentRevision = input.currentRevision;
    this.basisVersion = input.basisVersion;
    this.remoteRevisions = input.remoteRevisions;
    this.conflicts = input.conflicts;
  }
}

export class FrozenContractError extends Error {
  constructor(frozenVersion: string) {
    super(`契约已冻结为 v${frozenVersion}，固化内容不能再修改，请基于该版本发起新一版草稿。`);
    this.name = 'FrozenContractError';
  }
}

export class InvalidRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRevisionError';
  }
}

const CHANGE_FIELD_LABELS: Record<string, string> = {
  impactStatement: '调用方影响说明',
  migrationPlan: '迁移方案',
  before: '变更前',
  after: '变更后',
  rationale: '判定依据',
  kind: '变更类型',
};

export function nowIso(): string {
  return new Date().toISOString();
}

/** 语义指纹：仅契约定义相关内容，评审动作不会改变它 */
export function semanticSignature(contract: Pick<ApiContract, 'openapi' | 'changes'>): string {
  const changes = contract.changes.map((change) => [
    change.id,
    change.kind,
    change.before,
    change.after,
  ]);
  return JSON.stringify({ openapi: contract.openapi, changes });
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/** 冻结快照（定义 + 变更 + 调用方 + 豁免）的完整性校验值 */
export function snapshotChecksum(input: {
  openapi: string;
  changes: ContractChange[];
  consumers: ApiConsumer[];
  exemptions: Exemption[];
}): string {
  const payload = {
    openapi: input.openapi,
    changes: input.changes.map(
      ({ id, kind, before, after, compatibility, impactStatement, migrationPlan, reviewState }) => [
        id,
        kind,
        before,
        after,
        compatibility,
        impactStatement,
        migrationPlan,
        reviewState,
      ],
    ),
    consumers: input.consumers.map(({ id, clientVersion }) => [id, clientVersion]),
    exemptions: input.exemptions.map(({ id, changeId, scope, reason, approvedBy, expiresAt }) => [
      id,
      changeId,
      scope,
      reason,
      approvedBy,
      expiresAt,
    ]),
  };
  return hashString(JSON.stringify(payload));
}

export function requestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function exemptionIdFromRequest(requestIdValue: string): string {
  return `ex-${hashString(requestIdValue)}`;
}

export function versionIdFromRequest(contractId: string, requestIdValue: string): string {
  return `ver-${hashString(`${contractId}:${requestIdValue}`)}`;
}

// ---------------------------------------------------------------------------
// 旧数据迁移
// ---------------------------------------------------------------------------

function migrateChange(change: ContractChange, revision: number, basisVersion: string): ContractChange {
  if (change.basisRevision !== undefined) return change;
  const reviewed = change.reviewState !== 'pending' || change.reviewedAt;
  return {
    ...change,
    basisRevision: reviewed ? revision : undefined,
    basisSemanticRevision: reviewed ? revision : undefined,
    basisVersion: reviewed ? basisVersion || undefined : undefined,
  };
}

function migrateExemption(exemption: Exemption, revision: number): Exemption {
  if (exemption.basisRevision !== undefined) return exemption;
  return {
    ...exemption,
    basisRevision: revision,
    frozenInVersion: undefined,
  };
}

function migrateVersion(
  raw: ApiContract['versions'][number],
): ApiContract['versions'][number] | null {
  if (!raw) return null;
  const migrated = { ...raw };
  // 校验值是必填的固化数据，缺失则说明记录损坏，跳过避免污染门禁
  if (typeof migrated.checksum !== 'string' || !migrated.checksum) return null;
  if (typeof migrated.openapi !== 'string') migrated.openapi = '';
  if (!Array.isArray(migrated.changeIds)) migrated.changeIds = [];
  if (!Array.isArray(migrated.changes)) {
    // 旧版本没有固化变更：用空快照占位并标记 migrated，页面据此提示仅 OpenAPI 可比较
    migrated.changes = [];
    migrated.consumers = [];
    migrated.exemptions = [];
    migrated.revision = 0;
    migrated.semanticRevision = 0;
    migrated.migrated = true;
  }
  if (!Array.isArray(migrated.consumers)) migrated.consumers = [];
  if (!Array.isArray(migrated.exemptions)) migrated.exemptions = [];
  return migrated;
}

/** 把可能来自旧版本的数据补齐修订号与审核依据；已经是新结构时原样返回 */
export function migrateContract(raw: unknown): ApiContract | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<ApiContract>;
  if (typeof source.id !== 'string' || typeof source.openapi !== 'string') return null;

  const revision =
    typeof source.revision === 'number' && source.revision >= 1 ? source.revision : 1;
  const rawVersions = Array.isArray(source.versions) ? source.versions : [];
  let basisVersion = typeof source.basisVersion === 'string' ? source.basisVersion : '';
  // 旧数据：已冻结但缺依据版本时，补齐为最新冻结版本，避免被误判为冻结后的旧草稿
  if (!basisVersion && source.status === 'frozen' && rawVersions.length) {
    basisVersion = String(rawVersions[0]?.version ?? '');
  }
  const changes = Array.isArray(source.changes)
    ? source.changes.map((change) => migrateChange(change, revision, basisVersion))
    : [];
  const consumers = Array.isArray(source.consumers) ? source.consumers : [];
  const exemptions = Array.isArray(source.exemptions)
    ? source.exemptions.map((exemption) => migrateExemption(exemption, revision))
    : [];
  const versions = rawVersions
    .map(migrateVersion)
    .filter((item): item is ApiContract['versions'][number] => item !== null);

  const contract: ApiContract = {
    id: source.id,
    name: source.name ?? source.id,
    version: source.version ?? '0.0.0',
    domain: source.domain ?? '未分类',
    owner: source.owner ?? '未指定',
    protocol: source.protocol ?? 'REST',
    status: source.status ?? 'draft',
    updatedAt: source.updatedAt ?? nowIso(),
    openapi: source.openapi,
    changes,
    consumers,
    exemptions,
    versions,
    revision,
    semanticRevision:
      typeof source.semanticRevision === 'number' ? source.semanticRevision : revision,
    basisVersion,
    revisionLog: Array.isArray(source.revisionLog) ? source.revisionLog : [],
  };

  if (source.revision === undefined || !Array.isArray(source.revisionLog)) {
    contract.revisionLog = [
      {
        revision: contract.revision,
        at: contract.updatedAt,
        actor: '系统',
        action: 'migrated',
        summary: '旧数据迁移：已补齐修订号与审核依据',
        basisVersion: basisVersion || undefined,
      },
      ...contract.revisionLog,
    ];
    contract.updatedAt = source.updatedAt ?? contract.updatedAt;
  }
  return contract;
}

// ---------------------------------------------------------------------------
// 修订号校验
// ---------------------------------------------------------------------------

export function assertWritable(
  contract: ApiContract,
  expectedRevision?: number,
): void {
  if (contract.status === 'frozen') {
    throw new FrozenContractError(contract.version);
  }
  if (expectedRevision !== undefined && expectedRevision !== contract.revision) {
    throw new InvalidRevisionError(
      `修订号不匹配：提交基于 ${expectedRevision}，当前为 ${contract.revision}。`,
    );
  }
}

export function remoteRevisionsSince(
  contract: ApiContract,
  expectedRevision: number,
): RemoteRevision[] {
  return contract.revisionLog
    .filter((entry) => entry.revision > expectedRevision)
    .map((entry) => ({
      revision: entry.revision,
      at: entry.at,
      actor: entry.actor,
      summary: entry.summary,
      action: entry.action,
      basisVersion: entry.basisVersion,
    }));
}

function pushLog(
  contract: ApiContract,
  entry: Omit<RevisionLog, 'revision' | 'at'> & { at?: string },
): void {
  contract.revisionLog.unshift({
    revision: contract.revision,
    at: entry.at ?? nowIso(),
    actor: entry.actor,
    action: entry.action,
    summary: entry.summary,
    basisVersion: entry.basisVersion,
    requestId: entry.requestId,
  });
  if (contract.revisionLog.length > 100) {
    contract.revisionLog.length = 100;
  }
}

/** 应用一次被接收的写入：推进修订号、语义修订号、审计记录。
 * newState 为本次写入完成后的契约定义（OpenAPI + 变更描述），用于判断语义修订号是否推进。 */
export function bumpRevision(
  contract: ApiContract,
  entry: {
    actor: string;
    action: RevisionLog['action'];
    summary: string;
    requestId?: string;
    newState?: Pick<ApiContract, 'openapi' | 'changes'>;
    at?: string;
  },
): ApiContract {
  const next: ApiContract = structuredClone(contract);
  if (
    entry.newState &&
    semanticSignature(entry.newState) !== semanticSignature(next)
  ) {
    next.semanticRevision += 1;
  }
  next.revision += 1;
  next.updatedAt = entry.at ?? nowIso();
  pushLog(next, {
    actor: entry.actor,
    action: entry.action,
    summary: entry.summary,
    requestId: entry.requestId,
    basisVersion: next.basisVersion || undefined,
    at: entry.at,
  });
  return next;
}

// ---------------------------------------------------------------------------
// 三方合并（base：共同祖先，theirs：服务端当前，mine：本次提交）
// ---------------------------------------------------------------------------

function preview(value: string, max = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact || '（空）';
}

function threeWayScalar(input: {
  field: MergeField;
  label: string;
  base: string;
  theirs: string;
  mine: string;
  conflicts: FieldConflict[];
}): string {
  const { base, theirs, mine } = input;
  if (mine === base) return theirs;
  if (theirs === base) return mine;
  if (mine === theirs) return mine;
  input.conflicts.push({
    field: input.field,
    label: input.label,
    base: preview(base),
    theirs: preview(theirs),
    mine: preview(mine),
  });
  return theirs;
}

export interface MergeResult {
  merged: ApiContract;
  conflicts: FieldConflict[];
  remoteRevisions: RemoteRevision[];
}

/**
 * 只接收基于当前修订的改动：
 * - 对方改动而本地未动的字段，直接接收对方的值；
 * - 只有本地改动的字段，保留本地改动；
 * - 双方都改了同一字段则登记冲突，默认采用对方值，冲突交给页面确认。
 */
export function threeWayMerge(
  baseContract: ApiContract,
  theirs: ApiContract,
  mine: ApiContract,
): MergeResult {
  const conflicts: FieldConflict[] = [];
  const merged: ApiContract = structuredClone(theirs);

  merged.name = threeWayScalar({
    field: 'name',
    label: '契约名称',
    base: baseContract.name,
    theirs: theirs.name,
    mine: mine.name,
    conflicts,
  });
  merged.domain = threeWayScalar({
    field: 'domain',
    label: '所属领域',
    base: baseContract.domain,
    theirs: theirs.domain,
    mine: mine.domain,
    conflicts,
  });
  merged.owner = threeWayScalar({
    field: 'owner',
    label: '负责人',
    base: baseContract.owner,
    theirs: theirs.owner,
    mine: mine.owner,
    conflicts,
  });
  merged.openapi = threeWayScalar({
    field: 'openapi',
    label: 'OpenAPI 定义',
    base: baseContract.openapi,
    theirs: theirs.openapi,
    mine: mine.openapi,
    conflicts,
  });

  // 变更条目：以 id 做三方合并
  const baseChanges = new Map(baseContract.changes.map((change) => [change.id, change]));
  const theirChanges = new Map(theirs.changes.map((change) => [change.id, change]));
  const myChanges = new Map(mine.changes.map((change) => [change.id, change]));

  const changeIds: string[] = [];
  theirs.changes.forEach((change) => changeIds.push(change.id));
  mine.changes.forEach((change) => {
    if (!theirChanges.has(change.id)) changeIds.push(change.id);
  });

  merged.changes = changeIds.map((id) => {
    const baseChange = baseChanges.get(id);
    const theirChange = theirChanges.get(id);
    const myChange = myChanges.get(id);
    if (!theirChange) return myChange!;
    if (!myChange) return theirChange;

    const result = { ...theirChange };
    const keys: Array<keyof ContractChange> = [
      'impactStatement',
      'migrationPlan',
      'reviewState',
      'reviewComment',
      'reviewer',
      'reviewedAt',
      'before',
      'after',
      'kind',
      'rationale',
    ];
    for (const key of keys) {
      const baseValue = String(baseChange?.[key] ?? '');
      const theirValue = String(theirChange[key] ?? '');
      const myValue = String(myChange[key] ?? '');
      if (myValue === baseValue) {
        // 保留对方值
      } else if (theirValue === baseValue || myValue === theirValue) {
        (result as unknown as Record<string, unknown>)[key] = (myChange as unknown as Record<string, unknown>)[key];
      } else {
        conflicts.push({
          field: `change:${id}:${key}`,
          label: `${theirChange.method} ${theirChange.path} · ${CHANGE_FIELD_LABELS[key] ?? key}`,
          base: preview(baseValue),
          theirs: preview(theirValue),
          mine: preview(myValue),
          changeId: id,
        });
      }
    }
    return result;
  });

  // 调用方：按 id 做整条三方合并，双方编辑同一调用方且不一致时登记冲突
  const baseConsumers = new Map(baseContract.consumers.map((consumer) => [consumer.id, consumer]));
  const theirConsumers = new Map(theirs.consumers.map((consumer) => [consumer.id, consumer]));
  const myConsumers = new Map(mine.consumers.map((consumer) => [consumer.id, consumer]));
  merged.consumers = [];
  theirs.consumers.forEach((theirConsumer) => {
    const myConsumer = myConsumers.get(theirConsumer.id);
    const baseConsumer = baseConsumers.get(theirConsumer.id);
    if (!myConsumer) {
      merged.consumers.push(theirConsumer);
      return;
    }
    const mineChanged = JSON.stringify(myConsumer) !== JSON.stringify(baseConsumer);
    const theirsChanged = JSON.stringify(theirConsumer) !== JSON.stringify(baseConsumer);
    if (!mineChanged) {
      merged.consumers.push(theirConsumer);
    } else if (!theirsChanged || JSON.stringify(myConsumer) === JSON.stringify(theirConsumer)) {
      merged.consumers.push(myConsumer);
    } else {
      conflicts.push({
        field: `consumer:${theirConsumer.id}`,
        label: `调用方 ${theirConsumer.name}`,
        base: preview(JSON.stringify(baseConsumer ?? {})),
        theirs: preview(JSON.stringify(theirConsumer)),
        mine: preview(JSON.stringify(myConsumer)),
      });
      merged.consumers.push(theirConsumer);
    }
  });
  mine.consumers.forEach((consumer) => {
    if (!theirConsumers.has(consumer.id)) merged.consumers.push(consumer);
  });

  // 豁免：以 requestId / changeId 去重，重试不重复登记
  merged.exemptions = dedupeExemptions([...theirs.exemptions, ...mine.exemptions]);

  merged.versions = theirs.versions;
  merged.revision = theirs.revision;
  merged.semanticRevision = theirs.semanticRevision;
  merged.basisVersion = theirs.basisVersion;
  merged.revisionLog = theirs.revisionLog;
  merged.status = theirs.status;

  return {
    merged,
    conflicts,
    remoteRevisions: remoteRevisionsSince(theirs, baseContract.revision),
  };
}

function dedupeExemptions(exemptions: Exemption[]): Exemption[] {
  const seen = new Map<string, Exemption>();
  for (const exemption of exemptions) {
    const key =
      exemption.requestId ?? `change:${exemption.changeId}:${exemption.frozenInVersion ?? 'draft'}`;
    if (!seen.has(key)) {
      seen.set(key, exemption);
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// 发布门禁（含冻结固化、审核依据、旧草稿过期校验）
// ---------------------------------------------------------------------------

const FROZEN_FIELDS: Array<keyof ContractChange> = [
  'path',
  'method',
  'kind',
  'before',
  'after',
  'compatibility',
  'rationale',
  'impactStatement',
  'migrationPlan',
  'reviewState',
  'reviewer',
  'reviewComment',
  'reviewedAt',
];

/** 校验冻结快照的固化内容是否完整一致（防止固化值被篡改） */
export function frozenIntegrityIssues(contract: ApiContract): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];
  contract.versions.forEach((version) => {
    if (version.migrated) return;
    const changes = version.changes ?? [];
    const consumers = version.consumers ?? [];
    const exemptions = version.exemptions ?? [];
    const expected = snapshotChecksum({
      openapi: version.openapi,
      changes,
      consumers,
      exemptions,
    });
    if (expected !== version.checksum) {
      issues.push({
        id: `checksum-${version.id}`,
        severity: 'blocker',
        title: `v${version.version} 冻结快照校验失败`,
        detail: `固化内容与校验值 ${version.checksum} 不一致（当前计算 ${expected}），该版本不能作为发布依据。`,
      });
    }
    exemptions.forEach((exemption) => {
      if (exemption.frozenInVersion !== version.version) {
        issues.push({
          id: `ex-frozen-${version.id}-${exemption.id}`,
          severity: 'blocker',
          title: `v${version.version} 豁免固化标记缺失`,
          detail: `${exemption.scope} 未标记固化进该版本。`,
        });
      }
    });
    changes.forEach((change) => {
      if (change.frozenInVersion !== version.version) {
        issues.push({
          id: `chg-frozen-${version.id}-${change.id}`,
          severity: 'blocker',
          title: `v${version.version} 变更固化标记缺失`,
          detail: `${change.method} ${change.path} 未标记固化进该版本。`,
        });
      }
    });
  });
  return issues;
}

/**
 * 发布门禁完整判定：
 * 1. 冻结后旧草稿（basisVersion 落后）不能再过门禁；
 * 2. 审核依据必须对得上当前语义修订号；
 * 3. 冻结快照完整性；
 * 4. 既有的未评审/缺说明/缺迁移规则。
 */
export function releaseIssues(
  contract: ApiContract,
  baseIssues: ReleaseIssue[] = [],
): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [...frozenIntegrityIssues(contract)];

  const latest = contract.versions[0];
  // 工作副本依据的正式版本落后于最新冻结版本，即为冻结后遗留的旧草稿
  const staleDraft = !!latest && contract.basisVersion !== latest.version;

  if (staleDraft) {
    issues.push({
      id: 'stale-draft',
      severity: 'blocker',
      title: '冻结后的旧草稿不能发布',
      detail: `当前工作副本依据 v${contract.basisVersion || '无'}，最新正式版本是 v${latest!.version}。请基于最新冻结版本发起新一版草稿后再提交发布。`,
    });
  }

  contract.changes.forEach((change) => {
    if (change.frozenInVersion && change.frozenInVersion !== contract.version) {
      issues.push({
        id: `frozen-change-${change.id}`,
        severity: 'blocker',
        title: '冻结变更被改动',
        detail: `${change.method} ${change.path} 已固化进 v${change.frozenInVersion}，固化内容不能再修改。`,
        changeId: change.id,
      });
    }
    if (
      change.reviewState !== 'pending' &&
      change.basisSemanticRevision !== undefined &&
      // 契约定义在评审之后又被改动（语义修订号前进）才判定依据过期
      change.basisSemanticRevision < contract.semanticRevision &&
      change.basisVersion === contract.basisVersion
    ) {
      issues.push({
        id: `basis-stale-${change.id}`,
        severity: 'blocker',
        title: '评审依据已过期',
        detail: `${change.method} ${change.path} 的结论基于语义修订 ${change.basisSemanticRevision}，契约定义已更新到 ${contract.semanticRevision}，请重新评审。`,
        changeId: change.id,
      });
    }
    if (change.reviewState !== 'pending' && change.basisRevision === undefined) {
      issues.push({
        id: `basis-missing-${change.id}`,
        severity: 'blocker',
        title: '评审缺少审核依据',
        detail: `${change.method} ${change.path} 的结论未记录所基于的修订号，请重新确认评审。`,
        changeId: change.id,
      });
    }
  });

  if (staleDraft) {
    // 旧草稿只暴露过期阻断，避免把过期评审误算成新问题
    return issues;
  }

  return [...issues, ...baseIssues];
}

/** 冻结后校验工作副本里固化字段是否被改动（保存路径上调用） */
export function assertFrozenFieldsUntouched(
  before: ApiContract,
  after: ApiContract,
): void {
  if (before.status !== 'frozen' && !before.versions.length) return;
  const frozenVersion = before.status === 'frozen'
    ? before.version
    : before.versions.find((version) => version.version === before.basisVersion)?.version;
  if (!frozenVersion) return;
  after.changes.forEach((change) => {
    const previous = before.changes.find((item) => item.id === change.id);
    if (!previous || previous.frozenInVersion !== frozenVersion) return;
    for (const key of FROZEN_FIELDS) {
      if (previous[key] !== change[key]) {
        throw new FrozenContractError(frozenVersion);
      }
    }
  });
  after.exemptions.forEach((exemption) => {
    if (!exemption.frozenInVersion) return;
    const previous = before.exemptions.find((item) => item.id === exemption.id);
    if (!previous) return;
    if (
      previous.scope !== exemption.scope ||
      previous.reason !== exemption.reason ||
      previous.expiresAt !== exemption.expiresAt ||
      previous.approvedBy !== exemption.approvedBy
    ) {
      throw new FrozenContractError(frozenVersion);
    }
  });
}

// ---------------------------------------------------------------------------
// 有效视图：页面 / 发布门禁 / 变更报告显示同一个有效版本
// ---------------------------------------------------------------------------

export interface EffectiveView {
  /** 页面展示与门禁使用的契约：已冻结时展示冻结快照 */
  contract: ApiContract;
  /** 页面交互时实际使用的工作副本 */
  working: ApiContract;
  isFrozen: boolean;
  frozenVersion?: string;
  /** 该冻结版本是否为旧数据迁移补建（只能比较 OpenAPI） */
  migratedFrozen?: boolean;
}

export function effectiveView(working: ApiContract): EffectiveView {
  if (working.status !== 'frozen' || !working.versions.length) {
    return { contract: working, working, isFrozen: false };
  }
  const snapshot = working.versions[0];
  const frozen: ApiContract = {
    ...working,
    version: snapshot.version,
    openapi: snapshot.openapi,
    changes: snapshot.migrated
      ? working.changes.map((change) => ({ ...change, frozenInVersion: snapshot.version }))
      : snapshot.changes ?? [],
    consumers: snapshot.migrated ? working.consumers : (snapshot.consumers ?? []),
    exemptions: snapshot.migrated ? working.exemptions : (snapshot.exemptions ?? []),
  };
  return {
    contract: frozen,
    working,
    isFrozen: true,
    frozenVersion: snapshot.version,
    migratedFrozen: snapshot.migrated,
  };
}
