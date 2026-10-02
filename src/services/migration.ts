import type {
  ApiContract,
  ContractChange,
  ContractVersion,
  Exemption,
  LegacyContract,
  RevisionLogEntry,
} from '../models/contract';

/**
 * 旧数据首次打开迁移：
 * 1. 补齐工作副本修订号 revision 与依据版本 basisVersion；
 * 2. 为每条变更补齐审核依据（修订号/依据版本）；
 * 3. 为豁免补齐登记修订号与依据版本；
 * 4. 为已冻结版本补齐固化快照（变更、调用方、豁免、修订号、校验状态）；
 * 5. 写入一条 migration 修订日志。
 *
 * 迁移前的冻结校验值为历史手工值，无法重新验签，统一标记为 legacy，
 * 不参与篡改校验，但页面照常展示。
 */
export function migrateContract(raw: LegacyContract): ApiContract {
  const basisVersion = raw.versions[0]?.version ?? '';
  const revision = typeof raw.revision === 'number' ? raw.revision : 1;

  const changes: ContractChange[] = raw.changes.map((change) => ({
    ...change,
    reviewBasisRevision:
      typeof change.reviewBasisRevision === 'number'
        ? change.reviewBasisRevision
        : change.reviewState === 'pending'
          ? revision
          : 0,
    reviewBasisVersion: change.reviewBasisVersion ?? basisVersion,
  }));

  const exemptions: Exemption[] = raw.exemptions.map((item) => ({
    ...item,
    revision: typeof item.revision === 'number' ? item.revision : 0,
    basisVersion: item.basisVersion ?? basisVersion,
  }));

  const versions: ContractVersion[] = raw.versions.map((version) => {
    const hasSnapshot =
      'frozenChanges' in version &&
      Array.isArray((version as Partial<ContractVersion>).frozenChanges);
    if (hasSnapshot) {
      return version as ContractVersion;
    }
    // 旧快照只有 changeIds：尽量从当前工作副本匹配补入，并标记为历史快照
    const changeIds = new Set(version.changeIds);
    const frozenChanges = changes.filter((change) => changeIds.has(change.id));
    return {
      ...version,
      frozenRevision: 0,
      frozenChanges,
      frozenConsumers: raw.consumers.map((consumer) => structuredClone(consumer)),
      frozenExemptions: exemptions.map((item) => structuredClone(item)),
      snapshotStatus: 'legacy',
    };
  });

  const migrationLog: RevisionLogEntry = {
    revision,
    action: 'migration',
    author: '系统迁移',
    at: new Date().toISOString(),
    summary: '旧版数据首次打开：补齐修订号、审核依据与冻结快照。',
    changeIds: [],
    basisVersion,
    operationId: `migration-${raw.id}`,
  };

  return {
    ...raw,
    revision,
    basisVersion: raw.basisVersion ?? basisVersion,
    changes,
    exemptions,
    versions,
    revisionLog: dedupeMigrationLog(raw.revisionLog ?? [], migrationLog),
  };
}

function dedupeMigrationLog(
  log: RevisionLogEntry[],
  migration: RevisionLogEntry,
): RevisionLogEntry[] {
  if (log.some((entry) => entry.operationId === migration.operationId)) {
    return log;
  }
  return [migration, ...log];
}

export function isLegacyContract(raw: unknown): raw is LegacyContract {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const contract = raw as Partial<ApiContract>;
  return (
    typeof contract.revision !== 'number' ||
    typeof contract.basisVersion !== 'string' ||
    !Array.isArray(contract.revisionLog) ||
    !Array.isArray(contract.changes) ||
    !Array.isArray(contract.exemptions) ||
    !Array.isArray(contract.versions) ||
    contract.changes.some(
      (change) =>
        typeof change.reviewBasisRevision !== 'number' ||
        typeof change.reviewBasisVersion !== 'string',
    ) ||
    contract.exemptions.some(
      (item) => typeof item.revision !== 'number' || typeof item.basisVersion !== 'string',
    ) ||
    contract.versions.some((version) => !Array.isArray(version.frozenChanges))
  );
}

/** 迁移整库；返回迁移后的契约与是否发生过写入 */
export function migrateContracts(raw: unknown[]): {
  contracts: ApiContract[];
  migrated: boolean;
} {
  let migrated = false;
  const contracts = raw.map((item) => {
    if (isLegacyContract(item)) {
      migrated = true;
      return migrateContract(item);
    }
    return item as ApiContract;
  });
  return { contracts, migrated };
}
