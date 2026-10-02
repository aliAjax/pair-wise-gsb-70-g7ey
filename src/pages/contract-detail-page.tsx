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
  Hash,
  Layers3,
  LockKeyhole,
  RefreshCw,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChangeReviewItem } from '../components/contract/change-review-item';
import { CompatibilityBadge } from '../components/contract/compatibility-badge';
import { ConflictDialog } from '../components/contract/conflict-dialog';
import { ConsumerTable } from '../components/contract/consumer-table';
import { ContractEditor } from '../components/contract/contract-editor';
import { PendingRecoveryBanner } from '../components/contract/pending-recovery-banner';
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
  REVISION_ACTION_LABELS,
  REVIEW_STATE_LABELS,
  effectiveView,
  type ContractStatus,
  type ContractChange,
  type ReviewState,
  validateForRelease,
} from '../models/contract';
import {
  StorageWriteError,
  buildChangeReport,
  diffVersionSummary,
  generateExampleRequest,
  snapshotProblems,
} from '../services/contract-service';
import {
  useAddExemption,
  useContract,
  useFreezeVersion,
  useReviewChange,
  useSaveChangeFields,
  useStartNewDraft,
  useUpdateOpenApi,
} from '../services/contract-queries';
import { RevisionConflictError, type RemoteFieldChange } from '../services/revision-control';
import { revisionRequest } from '../services/revision-request';
import { useReviewStore } from '../store/review-store';

interface ConflictState {
  currentRevision: number;
  currentBasisVersion: string;
  remoteChanges: RemoteFieldChange[];
}

export function ContractDetailPage() {
  const { contractId } = useParams({ from: '/contracts/$contractId' });
  const contractQuery = useContract(contractId);
  const activeTab = useReviewStore((state) => state.activeTab);
  const setActiveTab = useReviewStore((state) => state.setActiveTab);
  const reviewChange = useReviewChange();
  const addExemption = useAddExemption();
  const updateOpenApi = useUpdateOpenApi();
  const saveFields = useSaveChangeFields();
  const freezeVersion = useFreezeVersion();
  const startNewDraft = useStartNewDraft();
  const [releaseVersion, setReleaseVersion] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [reviewFilter, setReviewFilter] = useState<ReviewState | 'all'>('all');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [notice, setNotice] = useState('');

  const contract = contractQuery.data;

  /**
   * 页面最后一次与服务端同步的修订坐标。
   * 所有保存都必须带上这个修订号与依据版本；它只在加载/保存成功后推进，
   * 本地编辑不会推进，因此两个窗口并发保存时后提交者会收到冲突。
   */
  const synced = useRef({ revision: 0, basisVersion: '' });
  useEffect(() => {
    if (!contract) {
      return;
    }
    synced.current = {
      revision: contract.revision,
      basisVersion: contract.basisVersion,
    };
  }, [contract]);

  const view = useMemo(() => (contract ? effectiveView(contract) : undefined), [contract]);
  const issues = useMemo(() => (view ? validateForRelease(view) : []), [view]);
  const blockers = issues.filter((issue) => issue.severity === 'blocker').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const acceptedCount =
    view?.changes.filter((change) => change.reviewState !== 'pending').length ?? 0;
  const reviewProgress = view?.changes.length
    ? Math.round((acceptedCount / view.changes.length) * 100)
    : 100;
  const selectedVersion =
    contract?.versions.find((version) => version.id === selectedVersionId) ??
    contract?.versions[0];
  const frozenProblems = useMemo(
    () => (contract ? snapshotProblems(contract) : []),
    [contract],
  );
  const busy =
    reviewChange.isPending ||
    addExemption.isPending ||
    updateOpenApi.isPending ||
    saveFields.isPending ||
    freezeVersion.isPending;

  if (contractQuery.isLoading) {
    return <PageState text="正在加载契约详情..." />;
  }
  if (contractQuery.isError || !contract || !view) {
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
  const frozen = view.frozen;

  function toConflict(error: unknown): boolean {
    if (error instanceof RevisionConflictError) {
      setConflict({
        currentRevision: error.currentRevision,
        currentBasisVersion: error.currentBasisVersion,
        remoteChanges: error.remoteChanges,
      });
      return true;
    }
    if (error instanceof StorageWriteError) {
      setNotice('写入失败，改动已保留为待恢复批次，可在页面顶部重试。');
      return true;
    }
    return false;
  }

  async function updateChange(
    changeId: string,
    baseValues: { impactStatement: string; migrationPlan: string },
    patch: Partial<Pick<ContractChange, 'impactStatement' | 'migrationPlan'>>,
  ) {
    setNotice('');
    try {
      await saveFields.mutateAsync({
        contractId,
        changeId,
        baseValues,
        patch,
        request: revisionRequest(synced.current, 'save-fields'),
      });
    } catch (error) {
      if (!toConflict(error)) {
        setNotice(error instanceof Error ? error.message : '保存失败');
      }
    }
  }

  async function handleReview(changeId: string, state: ReviewState, comment: string) {
    setNotice('');
    try {
      await reviewChange.mutateAsync({
        contractId,
        changeId,
        state,
        reviewer: '当前评审人',
        comment,
        request: revisionRequest(synced.current, 'review'),
      });
    } catch (error) {
      if (!toConflict(error)) {
        setNotice(error instanceof Error ? error.message : '评审提交失败');
      }
    }
  }

  async function handleExemption(changeId: string, reason: string) {
    setNotice('');
    try {
      await addExemption.mutateAsync({
        contractId,
        changeId,
        reason,
        request: revisionRequest(synced.current, 'exemption'),
      });
    } catch (error) {
      if (!toConflict(error)) {
        setNotice(error instanceof Error ? error.message : '豁免登记失败');
      }
    }
  }

  async function saveOpenApi(value: string) {
    setNotice('');
    try {
      await updateOpenApi.mutateAsync({
        contractId,
        openapi: value,
        request: revisionRequest(synced.current, 'openapi'),
      });
    } catch (error) {
      if (!toConflict(error)) {
        setNotice(error instanceof Error ? error.message : '契约定义保存失败');
      }
    }
  }

  async function freeze() {
    if (!releaseVersion.trim()) return;
    setNotice('');
    try {
      await freezeVersion.mutateAsync({
        contractId,
        version: releaseVersion.trim(),
        notes: releaseNotes.trim() || '本版契约变更评审完成。',
        request: revisionRequest(synced.current, 'freeze'),
      });
      setReleaseVersion('');
      setReleaseNotes('');
      setActiveTab('history');
    } catch (error) {
      if (!toConflict(error)) {
        setNotice(error instanceof Error ? error.message : '冻结失败');
      }
    }
  }

  const createNextDraft = async () => {
    setNotice('');
    const next = suggestVersion(contract.version);
    try {
      await startNewDraft.mutateAsync({
        contractId,
        nextVersion: next,
        request: revisionRequest(synced.current, 'new-draft'),
      });
      setActiveTab('overview');
    } catch (error) {
      if (!toConflict(error)) {
        setNotice(error instanceof Error ? error.message : '开启新草稿失败');
      }
    }
  };

  const exportReport = () => {
    downloadText(
      `${contract.id}-v${view.effectiveVersion}-r${view.revision}-change-report.md`,
      buildChangeReport(contract),
      'text/markdown;charset=utf-8',
    );
  };

  const exportJson = () => {
    downloadText(
      `${contract.id}-v${view.effectiveVersion}.json`,
      JSON.stringify(contract, null, 2),
      'application/json;charset=utf-8',
    );
  };

  const filteredChanges = view.changes.filter(
    (change) => reviewFilter === 'all' || change.reviewState === reviewFilter,
  );

  return (
    <div>
      <PendingRecoveryBanner />

      {conflict && (
        <ConflictDialog
          open
          currentRevision={conflict.currentRevision}
          currentBasisVersion={conflict.currentBasisVersion}
          remoteChanges={conflict.remoteChanges}
          onRefresh={() => {
            setConflict(null);
            void contractQuery.refetch();
          }}
          onMerge={() => {
            // 先看对方变更再合并：刷新为最新修订，表单回填对方内容，
            // 用户在此基础上补回自己的修改后重新保存（新的提交，新的修订号）
            setConflict(null);
            void contractQuery.refetch();
            setNotice('已载入对方最新内容，请在此基础上合并你的修改后重新保存。');
          }}
        />
      )}

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
              <Badge tone="slate">v{view.effectiveVersion}</Badge>
              <StatusPill status={contract.status} />
              {frozen && (
                <Badge tone="blue">
                  <LockKeyhole className="mr-1 h-3 w-3" />
                  校验值 {view.checksum}
                </Badge>
              )}
            </div>
            <h1 className="mt-2 text-2xl font-semibold text-slate-950 sm:text-3xl">
              {contract.name}
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              {contract.domain} · 负责人 {contract.owner} · 更新 {formatDateTime(contract.updatedAt)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1 font-mono">
                <Hash className="h-3 w-3" />
                当前修订 r{view.revision}
              </span>
              <span>
                依据版本：{view.basisVersion ? `v${view.basisVersion}` : '无（首次发布）'}
              </span>
              {!frozen && <span className="font-mono">工作副本校验值 {view.checksum}</span>}
            </div>
            {notice && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                <RefreshCw className="h-3 w-3" />
                {notice}
              </p>
            )}
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200">
            <HeaderMetric label="变更项" value={String(view.changes.length)} />
            <HeaderMetric label="调用方" value={String(view.consumers.length)} />
            <HeaderMetric
              label="发布门禁"
              value={frozen ? '已冻结' : blockers ? `${blockers} 阻断` : '通过'}
              danger={!frozen && !!blockers}
            />
          </div>
        </div>
      </section>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
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
              key={`${contract.id}-r${contract.revision}`}
              contract={contract}
              frozen={frozen}
              onSave={(value) => void saveOpenApi(value)}
              saving={updateOpenApi.isPending}
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
                        {acceptedCount} / {view.changes.length} 项已有结论
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
                    const count = view.changes.filter(
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
                  <p className="mt-1 text-xs text-slate-500">
                    基于{frozen ? '冻结有效版本' : '当前修订'}自动生成
                  </p>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100">
                    {generateExampleRequest(contract)}
                  </pre>
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
                  {frozen
                    ? '以下为冻结版本固化的评审记录，只读展示。'
                    : '每种变化必须逐条接受、退回或申请兼容层；保存带修订号，冲突时先看对方变更再合并。'}
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
                  key={`${change.id}-r${view.revision}`}
                  change={change}
                  basisVersion={view.basisVersion}
                  frozen={frozen}
                  saving={busy}
                  onReview={(changeId, state, comment) =>
                    void handleReview(changeId, state, comment)
                  }
                  onUpdate={(changeId, baseValues, patch) =>
                    void updateChange(changeId, baseValues, patch)
                  }
                  onExemption={(changeId, reason) => void handleExemption(changeId, reason)}
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
              <CardTitle>依赖调用方列表{frozen ? '（冻结快照）' : ''}</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                用于判断一次契约变化影响的客户端、环境与流量规模
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <ConsumerTable consumers={view.consumers} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="release">
          {frozenProblems.length > 0 && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {frozenProblems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}
          <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
            <Card>
              <CardHeader>
                <CardTitle>{frozen ? '冻结版本门禁结论' : '发布前门禁'}</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  {frozen
                    ? `v${view.effectiveVersion} 已冻结，门禁结论以固化快照为准。`
                    : `${blockers} 个阻断项，${warnings} 个警告（基于 r${view.revision}）`}
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
                    {frozen
                      ? `v${view.effectiveVersion} 的评审与迁移约束已随版本固化，校验值 ${view.checksum}。`
                      : '所有变更评审和迁移约束均已满足，可以冻结正式版本。'}
                  </div>
                )}
              </CardContent>
            </Card>

            {frozen ? (
              <Card>
                <CardHeader>
                  <CardTitle>冻结版本已固化</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">
                    变更、调用方、豁免与校验值不可再改，旧草稿不能再次过门禁
                  </p>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <span className="text-slate-500">版本号</span>
                    <strong>v{view.effectiveVersion}</strong>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <span className="text-slate-500">固化修订</span>
                    <strong className="font-mono">r{view.revision}</strong>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <span className="text-slate-500">校验值</span>
                    <strong className="font-mono">{view.checksum}</strong>
                  </div>
                  <Button className="w-full" onClick={() => void createNextDraft()}>
                    <FilePlus2 className="h-4 w-4" />
                    基于 v{view.effectiveVersion} 开启 v{suggestVersion(contract.version)} 新草稿
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>冻结正式版本</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">
                    冻结会固化当前修订 r{view.revision} 的变更、调用方、豁免与校验值
                  </p>
                </CardHeader>
                <CardContent>
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
                    onClick={() => void freeze()}
                  >
                    <LockKeyhole className="h-4 w-4" />
                    {freezeVersion.isPending ? '冻结中' : '确认发布并冻结'}
                  </Button>
                </CardContent>
              </Card>
            )}
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
                  {contract.versions.map((version) => (
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
                      <p className="mt-1 text-[10px] text-slate-400">
                        固化修订 r{version.frozenRevision || '迁移补齐'} ·{' '}
                        {version.snapshotStatus === 'legacy' ? '历史快照' : '校验通过'}
                      </p>
                    </button>
                  ))}
                  {!contract.versions.length && (
                    <p className="py-8 text-center text-sm text-slate-500">尚无正式版本。</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>与当前有效版本比较</CardTitle>
                  <p className="mt-1 whitespace-pre-line text-xs text-slate-500">
                    {diffVersionSummary(contract)}
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="overflow-hidden rounded-md border border-slate-200">
                    <DiffEditor
                      height="520px"
                      language="plaintext"
                      original={selectedVersion.openapi}
                      modified={view.openapi}
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

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>修订记录</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                保存、评审、豁免与冻结的修订轨迹，冲突时据此列出对方变更
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-80 divide-y divide-slate-100 overflow-auto">
                {[...(contract.revisionLog ?? [])].reverse().map((entry, index) => (
                  <div key={`${entry.operationId}-${index}`} className="px-4 py-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">r{entry.revision}</Badge>
                      <strong className="text-slate-800">
                        {REVISION_ACTION_LABELS[entry.action]}
                      </strong>
                      <span className="text-slate-500">{entry.author}</span>
                      <span className="ml-auto text-slate-400">{formatDateTime(entry.at)}</span>
                    </div>
                    <p className="mt-1 text-slate-600">{entry.summary}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-slate-400">
                      依据 {entry.basisVersion ? `v${entry.basisVersion}` : '首次发布'} ·{' '}
                      {entry.operationId}
                    </p>
                  </div>
                ))}
                {!(contract.revisionLog ?? []).length && (
                  <p className="px-4 py-10 text-center text-sm text-slate-500">暂无修订记录。</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="report">
          <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>变更报告预览</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">
                    {frozen ? '与冻结有效版本一致' : '与当前修订工作副本一致'} · Markdown 归档
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={exportReport}>
                  <Download className="h-3.5 w-3.5" />
                  导出报告
                </Button>
              </CardHeader>
              <CardContent>
                <pre className="max-h-[650px] overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100">
                  {buildChangeReport(contract)}
                </pre>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>报告要素</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <ReportFact icon={GitCompare} label="有效版本" value={`v${view.effectiveVersion}`} />
                  <ReportFact icon={Hash} label="修订号" value={`r${view.revision}`} />
                  <ReportFact
                    icon={GitCompare}
                    label="变更明细"
                    value={`${view.changes.length} 项`}
                  />
                  <ReportFact
                    icon={Users}
                    label="调用方影响"
                    value={`${view.consumers.length} 个客户端`}
                  />
                  <ReportFact
                    icon={Layers3}
                    label="兼容层豁免"
                    value={`${view.exemptions.length} 条`}
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

function StatusPill({ status }: { status: ContractStatus }) {
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

function suggestVersion(current: string): string {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return current;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
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
