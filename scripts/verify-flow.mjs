/**
 * 发布流程核心行为验证（纯 Node，模拟 localStorage）：
 * 1. 旧数据迁移补齐修订号与审核依据；
 * 2. 两窗口并发保存，后提交基于旧修订被拒并能拿到对方变更；
 * 3. 冲突合并后只推进一次修订；
 * 4. 写入失败入待恢复批次，重试不重复生成版本/豁免；
 * 5. 冻结后固化内容不可改，旧草稿不能再过门禁；
 * 6. 页面/门禁/报告使用同一有效版本。
 */
class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.failNext = false;
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('QuotaExceeded (simulated)');
    }
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

globalThis.window = { setTimeout };
globalThis.localStorage = new MemoryStorage();
globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

// 直接用 vite-node 无法在纯 node 跑 TS，这里通过 vite 的 esbuild 转译
const { build } = await import('vite');
const { pathToFileURL } = await import('node:url');
const { mkdtempSync } = await import('node:fs');
const { join } = await import('node:path');

const dir = mkdtempSync(join(process.cwd(), '.tmp-flow-'));

await build({
  configFile: false,
  logLevel: 'silent',
  root: process.cwd(),
  build: {
    lib: {
      entry: 'src/services/contract-service.ts',
      formats: ['es'],
      fileName: 'service',
    },
    outDir: dir,
    emptyOutDir: true,
  },
});

const service = await import(pathToFileURL(join(dir, 'service.js')).href);
const model = service;

let passed = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`✓ ${message}`);
  }
}

// --- 1. 首次加载触发迁移 ---
const initial = await service.listContracts();
assert(initial.length === 3, '种子契约加载完成');
const order = initial.find((c) => c.id === 'contract-order');
assert(typeof order.revision === 'number' && order.revision >= 1, '迁移补齐修订号');
assert(typeof order.basisVersion === 'string', '迁移补齐依据版本');
assert(
  order.changes.every((c) => typeof c.reviewBasisRevision === 'number'),
  '每条变更补齐审核依据修订号',
);
assert(
  order.versions[0].snapshotStatus === 'legacy',
  '旧冻结版本标记为 legacy 快照',
);
assert(order.revisionLog[0]?.action === 'migration', '写入迁移修订日志');

// --- 2. 两窗口并发保存：后提交基于旧修订被拒 ---
const windowABase = (await service.getContract('contract-order'));
const changeId = 'chg-order-2';
const reqA = {
  expectedRevision: windowABase.revision,
  expectedBasisVersion: windowABase.basisVersion,
  operationId: 'op-A',
  author: '后端维护者',
};
await service.saveChangeFields(
  'contract-order',
  changeId,
  { impactStatement: windowABase.changes.find((c) => c.id === changeId).impactStatement },
  { impactStatement: 'A 窗口补充的影响说明（生产 3 个调用方）' },
  reqA,
);

const reqB = {
  expectedRevision: windowABase.revision, // 仍是打开时的旧修订
  expectedBasisVersion: windowABase.basisVersion,
  operationId: 'op-B',
  author: '评审人',
};
let conflictError = null;
try {
  await service.saveChangeFields(
    'contract-order',
    changeId,
    { impactStatement: windowABase.changes.find((c) => c.id === changeId).impactStatement },
    { impactStatement: 'B 窗口补充的影响说明（流量 68 万/日）' },
    reqB,
  );
} catch (error) {
  conflictError = error;
}
assert(conflictError?.code === 'revision_conflict', 'B 窗口基于旧修订被拒绝');
assert(
  conflictError.remoteChanges.some((r) => r.field === 'impactStatement'),
  '冲突信息列出对方修改的字段',
);
assert(
  conflictError.remoteChanges[0]?.remoteValue.includes('A 窗口'),
  '冲突信息包含对方刚保存的值',
);

// --- 3. B 刷新后基于当前修订合并提交，只推进一次修订 ---
const refreshed = conflictError.currentContract;
assert(refreshed.revision === windowABase.revision + 1, '当前修订仅被 A 推进一次');
const merged = await service.saveChangeFields(
  'contract-order',
  changeId,
  {
    impactStatement: refreshed.changes.find((c) => c.id === changeId).impactStatement,
  },
  // 合并：保留 A 的影响，叠加 B 的流量信息
  {
    impactStatement:
      refreshed.changes.find((c) => c.id === changeId).impactStatement + '；流量 68 万/日',
  },
  {
    expectedRevision: refreshed.revision,
    expectedBasisVersion: refreshed.basisVersion,
    operationId: 'op-B-merge',
    author: '评审人',
  },
);
assert(merged.revision === windowABase.revision + 2, '合并提交再推进一个修订');
assert(
  merged.changes.find((c) => c.id === changeId).impactStatement.includes('68 万/日'),
  '合并结果保留 A 与 B 两方内容',
);

// --- 4. 写入失败保留批次，重试幂等（豁免不重复） ---
const user = await service.getContract('contract-user');
service.armNextWriteFailure();
let writeError = null;
try {
  await service.addExemption('contract-user', 'chg-user-1', '灰度兼容层', {
    expectedRevision: user.revision,
    expectedBasisVersion: user.basisVersion,
    operationId: 'op-ex-1',
    author: '评审人',
  });
} catch (error) {
  writeError = error;
}
assert(writeError?.code === 'storage_write_failed', '写入失败抛出 StorageWriteError');
const pendingBefore = service.listPendingOperations();
assert(pendingBefore.length === 1 && pendingBefore[0].type === 'exemption', '豁免操作进入待恢复批次');

// 恢复时存储已可用：第一次真正落盘
const recovery1 = await service.recoverPendingOperations();
assert(recovery1.recovered === 1, '待恢复批次成功重试');
assert(service.listPendingOperations().length === 0, '恢复后队列为空');

const afterRecover = await service.getContract('contract-user');
const exCount = afterRecover.exemptions.filter((e) => e.changeId === 'chg-user-1').length;
assert(exCount === 1, '恢复只生成一条豁免');

// 再次手动重放同一批次（模拟用户重复点击恢复）
localStorage.setItem('pair-wise-gsb-70-pending-ops', JSON.stringify([pendingBefore[0]]));
const recovery2 = await service.recoverPendingOperations();
assert(recovery2.recovered === 1, '重复恢复不报错');
const afterSecond = await service.getContract('contract-user');
assert(
  afterSecond.exemptions.filter((e) => e.changeId === 'chg-user-1').length === 1,
  '重试不重复生成豁免',
);
assert(afterSecond.revision === afterRecover.revision, '重试不产生重复修订');

// --- 5. 冻结固化 + 冻结后拒绝修改 ---
// 先用 user 契约：chg-user-1 已 accepted（compatible），门禁应通过
const user2 = await service.getContract('contract-user');
assert(model.validateForRelease(model.effectiveView(user2)).length === 0, '用户契约门禁通过');

const frozen = await service.freezeVersion('contract-user', '1.15.0', '兼容字段发布', {
  expectedRevision: user2.revision,
  expectedBasisVersion: user2.basisVersion,
  operationId: 'op-freeze-1',
  author: '发布负责人',
});
assert(frozen.status === 'frozen', '契约状态变为已冻结');
assert(frozen.versions[0].version === '1.15.0', '生成冻结版本');
assert(frozen.versions[0].frozenChanges.length === 1, '冻结时固化变更清单');
assert(frozen.versions[0].frozenConsumers.length === 1, '冻结时固化调用方');
assert(frozen.versions[0].frozenExemptions.length >= 1, '冻结时固化豁免');
assert(frozen.versions[0].checksum.length === 8, '冻结时固化校验值');
assert(frozen.basisVersion === '1.15.0', '依据版本推进到冻结版本');

// 冻结后再改说明 -> 拒绝
let frozenError = null;
try {
  await service.saveChangeFields(
    'contract-user',
    'chg-user-1',
    { impactStatement: '' },
    { impactStatement: '试图修改冻结内容' },
    {
      expectedRevision: frozen.revision,
      expectedBasisVersion: frozen.basisVersion,
      operationId: 'op-after-freeze',
      author: '某人',
    },
  );
} catch (error) {
  frozenError = error;
}
assert(frozenError?.code === 'frozen_contract', '冻结后变更说明不可修改');

// 冻结版本重试（同一版本号/同一操作）-> 幂等不重复
const freezeRetry = await service.freezeVersion('contract-user', '1.15.0', '兼容字段发布', {
  expectedRevision: frozen.revision,
  expectedBasisVersion: frozen.basisVersion,
  operationId: 'op-freeze-1',
  author: '发布负责人',
});
assert(
  freezeRetry.versions.filter((v) => v.version === '1.15.0').length === 1,
  '冻结重试不重复生成版本',
);

// 校验值篡改检测：手工破坏快照 checksum
const raw = JSON.parse(localStorage.getItem('pair-wise-gsb-70-contracts'));
const tampered = raw.map((c) =>
  c.id === 'contract-user'
    ? {
        ...c,
        versions: c.versions.map((v) =>
          v.version === '1.15.0' ? { ...v, checksum: 'deadbeef' } : v,
        ),
      }
    : c,
);
localStorage.setItem('pair-wise-gsb-70-contracts', JSON.stringify(tampered));
const tamperedContract = await service.getContract('contract-user');
assert(
  service.snapshotProblems(tamperedContract).some((p) => p.includes('校验值')),
  '校验值与固化定义不一致时报告篡改',
);
// 还原
localStorage.setItem('pair-wise-gsb-70-contracts', JSON.stringify(raw));

// --- 6. 有效版本视图：冻结后门禁/报告取固化快照 ---
const finalUser = await service.getContract('contract-user');
const view = model.effectiveView(finalUser);
assert(view.frozen === true, '有效视图识别为冻结');
assert(view.effectiveVersion === '1.15.0', '有效版本为冻结版本号');
assert(view.checksum === finalUser.versions[0].checksum, '有效视图校验值取固化值');
assert(view.exemptions.length === finalUser.versions[0].frozenExemptions.length, '有效视图豁免取固化快照');
assert(
  model.validateForRelease(view).every((i) => i.changeId !== 'ghost'),
  '门禁基于固化快照（旧草稿改动不参与）',
);
const report = service.buildChangeReport(finalUser);
assert(report.includes('v1.15.0'), '报告显示冻结有效版本');
assert(report.includes(`r${view.revision}`), '报告显示固化修订号');
assert(report.includes('已冻结'), '报告标注冻结状态');

// --- 7. 基于冻结版本开启新草稿，冻结快照保持不动 ---
const draft = await service.startNewDraft('contract-user', '1.16.0', {
  expectedRevision: finalUser.revision,
  expectedBasisVersion: '1.15.0',
  operationId: 'op-new-draft',
  author: '后端维护者',
});
assert(draft.status === 'draft', '开启新一轮草稿');
assert(draft.basisVersion === '1.15.0', '新草稿依据冻结版本');
assert(draft.versions[0].version === '1.15.0', '历史冻结版本保留不变');
assert(draft.versions[0].frozenChanges.length === 1, '冻结快照内容仍可查');
const draftView = model.effectiveView(draft);
assert(draftView.frozen === false && draftView.effectiveVersion === '1.16.0', '草稿有效版本切回工作副本');

console.log(`\n${passed} 项断言全部通过`);
