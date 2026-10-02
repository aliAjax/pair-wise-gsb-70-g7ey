export type ContractStatus = 'draft' | 'review' | 'ready' | 'released' | 'frozen';
export type ChangeKind =
  | 'field_added'
  | 'field_removed'
  | 'optionality_changed'
  | 'enum_expanded'
  | 'error_code_added'
  | 'error_code_removed';
export type Compatibility = 'compatible' | 'warning' | 'breaking';
export type ReviewState = 'pending' | 'accepted' | 'returned' | 'exemption';

export interface ContractChange {
  id: string;
  path: string;
  method: string;
  kind: ChangeKind;
  before: string;
  after: string;
  compatibility: Compatibility;
  rationale: string;
  impactStatement: string;
  migrationPlan: string;
  reviewState: ReviewState;
  reviewer: string;
  reviewComment: string;
  reviewedAt?: string;
  /** 审核依据：结论所基于的契约修订号 */
  basisRevision?: number;
  /** 审核依据：结论所基于的语义修订号（仅契约定义变化才推进） */
  basisSemanticRevision?: number;
  /** 审核依据：结论所基于的版本号 */
  basisVersion?: string;
  /** 结论固化进的正式版本，冻结后不再允许修改 */
  frozenInVersion?: string;
}

export interface ApiConsumer {
  id: string;
  name: string;
  owner: string;
  environment: '生产' | '预发' | '灰度';
  clientVersion: string;
  requestsPerDay: number;
  contact: string;
}

export interface Exemption {
  id: string;
  changeId: string;
  scope: string;
  reason: string;
  approvedBy: string;
  expiresAt: string;
  /** 申请幂等键：同一请求重试不会重复生成豁免 */
  requestId?: string;
  /** 登记时依据的契约修订号 */
  basisRevision?: number;
  /** 豁免固化进的正式版本，冻结后不再允许修改 */
  frozenInVersion?: string;
}

export interface ContractVersion {
  id: string;
  contractId: string;
  version: string;
  releasedAt: string;
  /** 冻结内容（OpenAPI 定义 + 变更 + 调用方 + 豁免）的校验值 */
  checksum: string;
  notes: string;
  changeIds: string[];
  openapi: string;
  /** 冻结时固化的变更与评审结论（旧数据迁移时可能缺失，由 migrateVersion 补建） */
  changes?: ContractChange[];
  /** 冻结时固化的调用方清单 */
  consumers?: ApiConsumer[];
  /** 冻结时固化的豁免记录 */
  exemptions?: Exemption[];
  /** 冻结时工作副本的修订号 */
  revision?: number;
  /** 冻结时工作副本的语义修订号 */
  semanticRevision?: number;
  /** 该正式版本基于的上一版本 */
  basisVersion?: string;
  /** 旧数据迁移补建的快照，历史记录未随快照保存 */
  migrated?: boolean;
}

export interface RevisionLog {
  /** 单调递增的修订号，从 1 开始 */
  revision: number;
  at: string;
  actor: string;
  action:
    | 'migrated'
    | 'draft_save'
    | 'openapi_edit'
    | 'review'
    | 'bulk_review'
    | 'exemption'
    | 'freeze'
    | 'start_draft';
  summary: string;
  /** 本次修订基于的版本号 */
  basisVersion?: string;
  /** 幂等请求标识 */
  requestId?: string;
}

export interface ApiContract {
  id: string;
  name: string;
  version: string;
  domain: string;
  owner: string;
  protocol: 'REST' | 'GraphQL' | 'gRPC-Web';
  status: ContractStatus;
  updatedAt: string;
  openapi: string;
  changes: ContractChange[];
  consumers: ApiConsumer[];
  exemptions: Exemption[];
  versions: ContractVersion[];
  /** 当前工作副本修订号，每次被接收的写入 +1 */
  revision: number;
  /** 当前语义修订号：只有契约定义（OpenAPI 或变更前后描述）变化才推进，评审/豁免不推进 */
  semanticRevision: number;
  /** 工作副本依据的最新正式版本号（尚未发布过为空串） */
  basisVersion: string;
  /** 修订审计记录，供冲突方先查看对方变更 */
  revisionLog: RevisionLog[];
}

export interface ReleaseIssue {
  id: string;
  severity: 'blocker' | 'warning';
  title: string;
  detail: string;
  changeId?: string;
}

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  field_added: '新增字段',
  field_removed: '删除字段',
  optionality_changed: '可选性变化',
  enum_expanded: '枚举扩展',
  error_code_added: '新增错误码',
  error_code_removed: '删除错误码',
};

export const COMPATIBILITY_LABELS: Record<Compatibility, string> = {
  compatible: '兼容',
  warning: '警告',
  breaking: '不兼容',
};

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  pending: '待评审',
  accepted: '已接受',
  returned: '已退回',
  exemption: '兼容层豁免',
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: '草稿',
  review: '评审中',
  ready: '待发布',
  released: '已发布',
  frozen: '已冻结',
};

export function classifyChange(input: {
  kind: ChangeKind;
  before: string;
  after: string;
}): { compatibility: Compatibility; rationale: string } {
  switch (input.kind) {
    case 'field_removed':
      return {
        compatibility: 'breaking',
        rationale: '删除字段会使仍读取该字段的客户端解析失败或业务判断缺失。',
      };
    case 'error_code_removed':
      return {
        compatibility: 'breaking',
        rationale: '删除错误码会破坏调用方基于错误码建立的分支与重试策略。',
      };
    case 'field_added':
      if (/required/i.test(input.after) || /必填/.test(input.after)) {
        return {
          compatibility: 'breaking',
          rationale: '新增必填字段要求现有调用方立即修改请求。',
        };
      }
      return {
        compatibility: 'compatible',
        rationale: '新增可选字段不会改变现有请求和响应结构。',
      };
    case 'optionality_changed':
      if (/可选.*必填|optional.*required/i.test(`${input.before} ${input.after}`)) {
        return {
          compatibility: 'breaking',
          rationale: '字段从可选变为必填，现有调用方可能不再满足请求约束。',
        };
      }
      return {
        compatibility: 'warning',
        rationale: '字段从必填变为可选会改变调用方对响应完整性的假设。',
      };
    case 'enum_expanded':
      return {
        compatibility: 'warning',
        rationale: '新增枚举值可能使未实现默认分支的客户端出现解析或展示异常。',
      };
    case 'error_code_added':
      return {
        compatibility: 'warning',
        rationale: '调用方应明确新错误码的展示和重试策略。',
      };
  }
}

/**
 * 只检查变更本身的评审与迁移约束（与修订/冻结状态无关的部分）。
 * 发布门禁的完整判定见 models/revision-engine.ts 的 releaseIssues。
 */
export function validateForRelease(contract: ApiContract): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];
  const pending = contract.changes.filter((change) => change.reviewState === 'pending');
  pending.forEach((change) => {
    issues.push({
      id: `pending-${change.id}`,
      severity: 'blocker',
      title: '存在未处理变更',
      detail: `${change.method} ${change.path} 仍处于待评审状态。`,
      changeId: change.id,
    });
  });

  contract.changes
    .filter((change) => change.reviewState !== 'exemption')
    .forEach((change) => {
      if (change.compatibility === 'compatible') {
        return;
      }
      if (!change.impactStatement.trim()) {
        issues.push({
          id: `impact-${change.id}`,
          severity: 'blocker',
          title: '缺少调用方影响说明',
          detail: `${change.path} 需要说明受影响调用方、流量和业务影响。`,
          changeId: change.id,
        });
      }
      if (!change.migrationPlan.trim()) {
        issues.push({
          id: `migration-${change.id}`,
          severity: 'blocker',
          title: '缺少迁移方案',
          detail: `${change.path} 需要给出客户端升级、兼容层或回滚路径。`,
          changeId: change.id,
        });
      }
    });

  contract.changes
    .filter(
      (change) =>
        change.compatibility === 'breaking' &&
        change.reviewState === 'accepted' &&
        !contract.exemptions.some((item) => item.changeId === change.id),
    )
    .forEach((change) => {
      issues.push({
        id: `breaking-${change.id}`,
        severity: 'warning',
        title: '不兼容变更已接受但未登记豁免',
        detail: `${change.path} 需要记录兼容层的范围、原因和到期时间。`,
        changeId: change.id,
      });
    });

  return issues;
}
