import { DiffEditor } from '@monaco-editor/react';
import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Download,
  FilePlus2,
  FileWarning,
  GitCompare,
  History,
  Layers3,
  LockKeyhole,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ChangeReviewItem } from '../components/contract/change-review-item';
import { CompatibilityBadge } from '../components/contract/compatibility-badge';
import { ConflictDialog } from '../components/contract/conflict-dialog';
import { ConsumerTable } from '../components/contract/consumer-table';
import { ContractEditor } from '../components/contract/contract-editor';
import { useConflictState, isConflictError } from '../components/contract/use-conflict-state';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Progress } from '../components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { formatDateTime } from '../lib/utils';
import {
  REVIEW_STATE_LABELS,
  type ApiContract,
  type ContractChange,
  type ReviewState,
  validateForRelease,
} from '../models/contract';
import {
  effectiveView,
  FrozenContractError,
  releaseIssues,
} from '../models/revision-engine';
import {
  buildChangeReport,
  diffVersionSummary,
  generateExampleRequest,
} from '../services/contract-service';
import {
  useAddExemption,
  useContract,
  useFreezeVersion,
  useReviewChange,
  useSaveContract,
  useStartNewDraft,
  useUpdateOpenApi,
} from '../services/contract-queries';
import { useReviewStore } from '../store/review-store';

export function ContractDetailPage() {
  const { contractId } = useParams({ from: '/contracts/$contractId' });
  const contractQuery = useContract(contractId);
  const activeTab = useReviewStore((state) => state.activeTab);
  const setActiveTab = useReviewStore((state) => state.setActiveTab);
  const reviewChange = useReviewChange();
  const addExemption = useAddExemption();
  const updateOpenApi = useUpdateOpenApi();
  const saveContract = useSaveContract();
  const freezeVersion = useFreezeVersion();
  const startNewDraft = useStartNewDraft();
  const [releaseVersion, setReleaseVersion] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [reviewFilter, setReviewFilter] = useState<ReviewState | 'all'>('all');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const conflictState = useConflictState();
  /** 打开页面时拿到的契约快照，作为三方合并的共同祖先 */
  const [baseSnapshot, setBaseSnapshot] = useState<ApiContract | null>(null);

  const working = contractQuery.data;
  const view = useMemo(() => (working ? effectiveView(working) : null), [working]);

  const issues = useMemo(() => {
    if (!working) return [];
    return releaseIssues(working, validateForRelease(working));
  }, [working]);
  const blockers = issues.filter((issue) => issue.severity === 'blocker').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const acceptedCount =
    view?.contract.changes.filter((change) => change.reviewState !== 'pending').length ?? 0;
  const reviewProgress = view?.contract.changes.length
    ? Math.round((acceptedCount / view.contract.changes.length) * 100)
    : 100;
  const selectedVersion =
    working?.versions.find((version) => version.id === selectedVersionId) ??
    working?.versions[0];

  if (contractQuery.isLoading) {
    return <PageState text="正在加载契约详情..." />;
  }
  if (contractQuery.isError || !working || !view) {
    return (
      <div className="rounded-lg border border-red-200 bg-white p-10 text-center">
        <h1 className="text-xl font-semibold">契约不存在</h1>
        <p className="mt-2 text-sm text-slate-500">记录可能已被删除，或链接无效。</p>
        <Link to="/" className="mt-5 inline-flex text-sm font-medium text-sky-800">
          返回契约工作台
        </Link>
      </div>
    );
  }

  const contract = view.contract;
  const isFrozen = view.isFrozen;
  const base = baseSnapshot ?? working;

  function captureBase(current: ApiContract) {
    if (!baseSnapshot) setBaseSnapshot(current);
  }

  function handleError(error: unknown) {
    if (isConflictError(error)) {
      // 没有可逐字段合并的冲突（如冻结/纯修订推进）：直接提示刷新，而不是弹空合并框
      if (!error.conflicts.length) {
        setFeedback({
          tone: 'error',
          text: `契约已被另一会话更新到修订 ${error.currentRevision}，当前操作无法自动合并，请刷新查看最新状态后重试。`,
        });
        return;
      }
      conflictState.capture(error);
      setFeedback(null);
      return;
    }
    if (error instanceof FrozenContractError) {
      setFeedback({ tone: 'error', text: error.message });
      return;
    }
    setFeedback({
      tone: 'error',
      text: error instanceof Error ? error.message : '操作失败，改动已保留在待恢复批次。',
    });
  }

  async function updateChange(current: ApiContract, changeId: string, patch: Partial<ContractChange>) {
    captureBase(current);
    setFeedback(null);
    const candidate: ApiContract = {
      ...current,
      changes: current.changes.map((change) =>
        change.id === changeId ? { ...change, ...patch } : change,
      ),
    };
    try {
      await saveContract.mutateAsync({
        contract: candidate,
        expectedRevision: current.revision,
        baseContract: baseSnapshot ?? current,
      });
      setFeedback({ tone: 'success', text: '影响说明与迁移方案已保存。' });
    } catch (error) {
      handleError(error);
    }
  }

  async function handleReview(current: ApiContract, changeId: string, state: ReviewState, comment: string) {
    captureBase(current);
    setFeedback(null);
    try {
      await reviewChange.mutateAsync({
        contractId,
        changeId,
        reviewState: state,
        reviewer: '当前评审人',
        comment,
        expectedRevision: current.revision,
      });
    } catch (error) {
      handleError(error);
    }
  }

  async function handleExemption(current: ApiContract, changeId: string, reason: string) {
    captureBase(current);
    setFeedback(null);
    try {
      await addExemption.mutateAsync({
        contractId,
        changeId,
        reason,
        expectedRevision: current.revision,
      });
    } catch (error) {
      handleError(error);
    }
  }

  async function saveOpenApi(current: ApiContract, value: string) {
    captureBase(current);
    setFeedback(null);
    try {
      await updateOpenApi.mutateAsync({
        contractId,
        openapi: value,
        expectedRevision: current.revision,
      });
    } catch (error) {
      handleError(error);
    }
  }

  async function freeze(current: ApiContract) {
    if (!releaseVersion.trim()) return;
    setFeedback(null);
    try {
      await freezeVersion.mutateAsync({
        contractId,
        version: releaseVersion.trim(),
        notes: releaseNotes.trim() || '本版契约变更评审完成。',
        expectedRevision: current.revision,
      });
      setReleaseVersion('');
      setReleaseNotes('');
      setBaseSnapshot(null);
      setFeedback({ tone: 'success', text: '正式版本已冻结，变更、调用方、豁免与校验值已固化。' });
    } catch (error) {
      handleError(error);
    }
  }

  async function startDraft(current: ApiContract) {
    setFeedback(null);
    try {
      await startNewDraft.mutateAsync({
        contractId,
        expectedRevision: current.revision,
      });
      setBaseSnapshot(null);
      setFeedback({ tone: 'success', text: '已基于冻结版本发起新一版草稿，可以继续编辑。' });
    } catch (error) {
      handleError(error);
    }
  }

  async function refreshFromRemote() {
    setBaseSnapshot(null);
    conflictState.close();
    await contractQuery.refetch();
  }

  /** 冲突合并：把用户选择保留本地的字段并入当前工作副本后重新提交 */
  async function confirmMergedSave() {
    if (!conflictState.conflict || !working) return;
    const local = baseSnapshot ?? working;
    const candidate: ApiContract = { ...working };
    conflictState.conflict.conflicts.forEach((item) => {
      if (!conflictState.chosenMine.has(item.field)) return;
      if (item.field === 'openapi') {
        // 本地 OpenAPI 来自最近一次未保存编辑，合并时以服务端为准，提示用户重新编辑
        return;
      }
      if (item.field.startsWith('change:')) {
        const [, changeId, key] = item.field.split(':');
        const localChange = local.changes.find((change) => change.id === changeId);
        if (localChange) {
          candidate.changes = candidate.changes.map((change) =>
            change.id === changeId
              ? ({
                  ...change,
                  [key]: (localChange as unknown as Record<string, unknown>)[key],
                } as ContractChange)
              : change,
          );
        }
      }
      if (item.field.startsWith('consumer:')) {
        const consumerId = item.field.split(':')[1];
        const localConsumer = local.consumers.find((consumer) => consumer.id === consumerId);
        if (localConsumer) {
          candidate.consumers = candidate.consumers.map((consumer) =>
            consumer.id === consumerId ? localConsumer : consumer,
          );
        }
      }
    });
    try {
      await saveContract.mutateAsync({
        contract: candidate,
        expectedRevision: working.revision,
        baseContract: base,
        resolveWithMine: [...conflictState.chosenMine] as Parameters<
          typeof saveContract.mutateAsync
        >[0]['resolveWithMine'],
      });
      conflictState.close();
      setBaseSnapshot(null);
      setFeedback({ tone: 'success', text: '已按你的选择合并对方修订并提交。' });
    } catch (error) {
      if (!conflictState.capture(error)) handleError(error);
    }
  }

  function exportReport() {
    downloadText(
      `${contract.id}-${contract.version}-change-report.md`,
      buildChangeReport(contract, working),
      'text/markdown;charset=utf-8',
    );
  }

  function exportJson() {
    downloadText(
      `${contract.id}-${contract.version}.json`,
      JSON.stringify(working, null, 2),
      'application/json;charset=utf-8',
    );
  }

  const filteredChanges = contract.changes.filter(
    (change) => reviewFilter === 'all' || change.reviewState === reviewFilter,
  );
  const busy =
    reviewChange.isPending ||
    addExemption.isPending ||
    updateOpenApi.isPending ||
    saveContract.isPending ||
    freezeVersion.isPending ||
    startNewDraft.isPending;

  return (
    <div>
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-800 hover:text-sky-950"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回契约清单
      </Link>

      <section className="mt-3 border-b border-slate-200 pb-5">
        <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-sky-800">{contract.protocol}</span>
              <Badge tone="slate">v{contract.version}</Badge>
              <StatusPill status={working.status} />
              <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                工作副本 r{working.revision} · 语义 r{working.semanticRevision}
              </span>
              {working.basisVersion && (
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                  依据 v{working.basisVersion}
                </span>
              )}
            </div>
            <h1 className="mt-2 text-2xl font-semibold text-slate-950 sm:text-3xl">
              {contract.name}
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              {contract.domain} · 负责人 {contract.owner} · 更新 {formatDateTime(working.updatedAt)}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200">
            <HeaderMetric label="变更项" value={String(contract.changes.length)} />
            <HeaderMetric label="调用方" value={String(contract.consumers.length)} />
            <HeaderMetric label="发布门禁" value={blockers ? `${blockers} 阻断` : '通过'} danger={!!blockers} />
          </div>
        </div>

        {isFrozen && (
          <div className="mt-4 flex flex-col gap-3 rounded-md border border-slate-300 bg-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-sm text-slate-700">
              <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />
              <div>
                <strong>v{view.frozenVersion} 已冻结。</strong>
                页面、发布门禁与变更报告均显示该有效版本，固化的变更、调用方、豁免和校验值不能再修改。
                {view.migratedFrozen && (
                  <span className="mt-1 block text-xs text-slate-500">
                    该版本来自旧数据迁移补建，仅完整保留 OpenAPI 快照，变更明细以当前记录展示。
                  </span>
                )}
              </div>
            </div>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void startDraft(working)}>
              <FilePlus2 className="h-3.5 w-3.5" />
              {startNewDraft.isPending ? '创建中' : '基于此版本发起新草稿'}
            </Button>
          </div>
        )}

        {feedback && (
          <div
            className={
              feedback.tone === 'error'
                ? 'mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800'
                : 'mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800'
            }
          >
            {feedback.text}
          </div>
        )}
      </section>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mt-4"
      >
        <TabsList>
          <TabsTrigger value="overview">概览与契约</TabsTrigger>
          <TabsTrigger value="changes">差异评审</TabsTrigger>
          <TabsTrigger value="consumers">调用方</TabsTrigger>
          <TabsTrigger value="release">发布门禁</TabsTrigger>
          <TabsTrigger value="history">版本历史</TabsTrigger>
          <TabsTrigger value="report">变更报告</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
            <ContractEditor
              key={`${contract.id}-${working.revision}-${contract.openapi}`}
              contract={contract}
              onSave={(value) => void saveOpenApi(working, value)}
              saving={updateOpenApi.isPending}
              readOnly={isFrozen}
              revision={working.revision}
            />
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>评审进度</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end justify-between">
                    <div>
                      <span className="text-3xl font-semibold">{reviewProgress}%</span>
                      <p className="mt-1 text-xs text-slate-500">
                        {acceptedCount} / {contract.changes.length} 项已有结论
                      </p>
                    </div>
                    {!blockers && <CheckCircle2 className="h-6 w-6 text-emerald-600" />}
                  </div>
                  <Progress className="mt-4" value={reviewProgress} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>兼容性摘要</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(['compatible', 'warning', 'breaking'] as const).map((level) => {
                    const count = contract.changes.filter(
                      (change) => change.compatibility === level,
                    ).length;
                    return (
                      <div key={level} className="flex items-center justify-between">
                        <CompatibilityBadge value={level} />
                        <strong className="text-sm">{count} 项</strong>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>示例请求</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">根据当前有效版本自动生成</p>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100">
                    {generateExampleRequest(contract)}
                  </pre>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <History className="h-4 w-4 text-sky-800" />
                    修订记录
                  </CardTitle>
                </CardHeader>
                <CardContent className="max-h-56 space-y-2 overflow-auto">
                  {working.revisionLog.slice(0, 8).map((entry) => (
                    <div key={`${entry.revision}-${entry.at}`} className="text-[11px] leading-5">
                      <div className="flex items-center gap-1.5">
                        <Badge tone="slate">r{entry.revision}</Badge>
                        <span className="font-medium text-slate-700">{entry.actor}</span>
                      </div>
                      <p className="mt-0.5 text-slate-500">{entry.summary}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="changes">
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>字段与错误码差异</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  {isFrozen
                    ? '该版本已冻结，评审结论与豁免为固化记录'
                    : '每种变化必须逐条接受、退回或申请兼容层；保存带当前修订号，并发改动会先合并'}
                </p>
              </div>
              <Select
                value={reviewFilter}
                onValueChange={(value) => setReviewFilter(value as ReviewState | 'all')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部评审状态</SelectItem>
                  {Object.entries(REVIEW_STATE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent className="p-0">
              {filteredChanges.map((change) => (
                <ChangeReviewItem
                  key={`${change.id}-${working.revision}-${change.reviewState}-${change.impactStatement}-${change.migrationPlan}`}
                  change={change}
                  readOnly={isFrozen}
                  saving={busy}
                  onReview={(changeId, state, comment) =>
                    void handleReview(working, changeId, state, comment)
                  }
                  onUpdate={(changeId, patch) => void updateChange(working, changeId, patch)}
                  onExemption={(changeId, reason) => void handleExemption(working, changeId, reason)}
                />
              ))}
              {!filteredChanges.length && (
                <p className="p-10 text-center text-sm text-slate-500">没有符合条件的变更项。</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="consumers">
          <Card>
            <CardHeader>
              <CardTitle>依赖调用方列表{isFrozen && `（v${view.frozenVersion} 固化）`}</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                用于判断一次契约变化影响的客户端、环境与流量规模
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <ConsumerTable consumers={contract.consumers} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="release">
          <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
            <Card>
              <CardHeader>
                <CardTitle>发布前门禁</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  {blockers} 个阻断项，{warnings} 个警告 · 工作副本 r{working.revision}，依据版本{' '}
                  {working.basisVersion || '无'}
                </p>
              </CardHeader>
              <CardContent>
                {issues.map((issue) => (
                  <div
                    key={issue.id}
                    className={
                      issue.severity === 'blocker'
                        ? 'border-b border-red-100 bg-red-50 px-3 py-3 first:rounded-t-md'
                        : 'border-b border-amber-100 bg-amber-50 px-3 py-3'
                    }
                  >
                    <div className="flex items-center gap-2">
                      {issue.severity === 'blocker' ? (
                        <FileWarning className="h-4 w-4 text-red-700" />
                      ) : (
                        <Clock3 className="h-4 w-4 text-amber-700" />
                      )}
                      <strong className="text-sm">{issue.title}</strong>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{issue.detail}</p>
                  </div>
                ))}
                {!issues.length && (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                    所有变更评审和迁移约束均已满足，可以冻结正式版本。
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>冻结正式版本</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  冻结后变更、调用方、豁免与校验值固化，不可覆盖；重试不会重复生成版本
                </p>
              </CardHeader>
              <CardContent>
                {isFrozen ? (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                    <LockKeyhole className="mb-2 h-5 w-5 text-slate-500" />
                    当前有效版本 v{view.frozenVersion} 已冻结。如需继续变更，请先在上方发起新一版草稿。
                  </div>
                ) : (
                  <>
                    <label className="text-xs font-medium text-slate-700">版本号</label>
                    <Input
                      className="mt-1.5"
                      value={releaseVersion}
                      onChange={(event) => setReleaseVersion(event.target.value)}
                      placeholder="例如 2.9.0"
                    />
                    <label className="mt-4 block text-xs font-medium text-slate-700">发布说明</label>
                    <Textarea
                      className="mt-1.5"
                      value={releaseNotes}
                      onChange={(event) => setReleaseNotes(event.target.value)}
                      placeholder="说明本版接口变化、兼容层和调用方升级状态"
                    />
                    <Button
                      className="mt-4 w-full"
                      disabled={!!blockers || !releaseVersion.trim() || freezeVersion.isPending}
                      onClick={() => void freeze(working)}
                    >
                      <LockKeyhole className="h-4 w-4" />
                      {freezeVersion.isPending ? '冻结中' : '确认发布并冻结'}
                    </Button>
                    <p className="mt-2 text-[10px] leading-4 text-slate-400">
                      提交基于修订号 {working.revision}。冻结过程若写入失败会进入待恢复批次，按同一请求重试不会产生重复版本。
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="history">
          {selectedVersion ? (
            <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
              <Card>
                <CardHeader>
                  <CardTitle>正式版本</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {working.versions.map((version) => (
                    <button
                      key={version.id}
                      type="button"
                      className={
                        selectedVersion.id === version.id
                          ? 'w-full rounded-md border border-sky-300 bg-sky-50 p-3 text-left'
                          : 'w-full rounded-md border border-slate-200 p-3 text-left hover:bg-slate-50'
                      }
                      onClick={() => setSelectedVersionId(version.id)}
                    >
                      <div className="flex items-center justify-between">
                        <strong className="text-sm">v{version.version}</strong>
                        <span className="font-mono text-[10px] text-slate-500">
                          {version.checksum}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-600">{version.notes}</p>
                      {version.migrated && (
                        <Badge className="mt-1" tone="amber">旧版迁移补建</Badge>
                      )}
                    </button>
                  ))}
                  {!working.versions.length && (
                    <p className="py-8 text-center text-sm text-slate-500">尚无正式版本。</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>与当前工作副本比较</CardTitle>
                  <p className="mt-1 whitespace-pre-line text-xs text-slate-500">
                    {diffVersionSummary(working)}
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="overflow-hidden rounded-md border border-slate-200">
                    <DiffEditor
                      height="520px"
                      language="plaintext"
                      original={selectedVersion.openapi}
                      modified={working.openapi}
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        renderSideBySide: true,
                        fontSize: 12,
                        automaticLayout: true,
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card>
              <CardContent className="py-14 text-center text-sm text-slate-500">
                暂无版本可比较。
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="report">
          <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>变更报告预览</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">
                    {isFrozen ? `展示有效版本 v${view.frozenVersion} 的固化内容` : 'Markdown 格式，可直接进入评审材料'}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={exportReport}>
                  <Download className="h-3.5 w-3.5" />
                  导出报告
                </Button>
              </CardHeader>
              <CardContent>
                <pre className="max-h-[650px] overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100">
                  {buildChangeReport(contract, working)}
                </pre>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>报告要素</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <ReportFact
                    icon={GitCompare}
                    label="变更明细"
                    value={`${contract.changes.length} 项`}
                  />
                  <ReportFact
                    icon={Users}
                    label="调用方影响"
                    value={`${contract.consumers.length} 个客户端`}
                  />
                  <ReportFact
                    icon={Layers3}
                    label="兼容层豁免"
                    value={`${contract.exemptions.length} 条`}
                  />
                  <ReportFact
                    icon={LockKeyhole}
                    label="有效版本"
                    value={isFrozen ? `v${view.frozenVersion}（已冻结）` : '工作草稿'}
                  />
                </CardContent>
              </Card>
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={exportJson}>
                  导出 JSON
                </Button>
                <Button variant="outline" className="flex-1" onClick={exportReport}>
                  导出 Markdown
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <ConflictDialog
        open={!!conflictState.conflict}
        onOpenChange={(open) => !open && conflictState.close()}
        currentRevision={conflictState.conflict?.currentRevision ?? working.revision}
        expectedRevision={conflictState.conflict?.expectedRevision ?? working.revision}
        basisVersion={conflictState.conflict?.basisVersion ?? ''}
        remoteRevisions={conflictState.conflict?.remoteRevisions ?? []}
        conflicts={conflictState.conflict?.conflicts ?? []}
        chosenMine={conflictState.chosenMine}
        onToggleChoice={conflictState.toggleChoice}
        onConfirm={() => void confirmMergedSave()}
        onRefresh={() => void refreshFromRemote()}
        submitting={saveContract.isPending}
      />
    </div>
  );
}

function HeaderMetric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="min-w-24 bg-white px-4 py-3">
      <span className="text-[11px] text-slate-500">{label}</span>
      <strong className={danger ? 'mt-1 block text-red-700' : 'mt-1 block text-slate-900'}>
        {value}
      </strong>
    </div>
  );
}

function StatusPill({ status }: { status: ApiContract['status'] }) {
  const label = {
    draft: '草稿',
    review: '评审中',
    ready: '待发布',
    released: '已发布',
    frozen: '已冻结',
  }[status];
  const tone = {
    draft: 'neutral',
    review: 'amber',
    ready: 'blue',
    released: 'green',
    frozen: 'slate',
  }[status] as 'neutral' | 'amber' | 'blue' | 'green' | 'slate';
  return <Badge tone={tone}>{label}</Badge>;
}

function ReportFact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof GitCompare;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <span className="flex items-center gap-2 text-slate-600">
        <Icon className="h-4 w-4 text-sky-800" />
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

function PageState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-5 py-16 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
