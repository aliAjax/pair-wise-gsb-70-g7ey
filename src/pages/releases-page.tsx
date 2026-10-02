import { Link } from '@tanstack/react-router';
import { Archive, CheckCircle2, LockKeyhole, PackageCheck, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConflictDialog } from '../components/contract/conflict-dialog';
import { PendingRecoveryBanner } from '../components/contract/pending-recovery-banner';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { formatDateTime } from '../lib/utils';
import { effectiveView, validateForRelease } from '../models/contract';
import {
  StorageWriteError,
} from '../services/contract-service';
import {
  useContracts,
  useFreezeVersion,
} from '../services/contract-queries';
import { RevisionConflictError } from '../services/revision-control';
import { revisionRequest } from '../services/revision-request';
import { useReviewStore } from '../store/review-store';

interface ConflictInfo {
  currentRevision: number;
  currentBasisVersion: string;
}

export function ReleasesPage() {
  const contracts = useContracts();
  const freezeVersion = useFreezeVersion();
  const selectedContractId = useReviewStore((state) => state.selectedContractId);
  const setSelectedContract = useReviewStore((state) => state.setSelectedContract);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [notice, setNotice] = useState('');

  const selectedContract = (contracts.data ?? []).find(
    (contract) => contract.id === selectedContractId,
  );
  const selectedView = selectedContract ? effectiveView(selectedContract) : undefined;
  const selectedIssues = selectedView ? validateForRelease(selectedView) : [];
  const blockers = selectedIssues.filter((issue) => issue.severity === 'blocker').length;
  const frozenSelected = selectedView?.frozen ?? false;

  const versions = useMemo(
    () =>
      (contracts.data ?? [])
        .flatMap((contract) =>
          contract.versions.map((release) => ({ contract, release })),
        )
        .sort(
          (left, right) =>
            new Date(right.release.releasedAt).getTime() -
            new Date(left.release.releasedAt).getTime(),
        ),
    [contracts.data],
  );

  async function freeze() {
    if (!selectedContract || !version.trim() || blockers || frozenSelected) return;
    setNotice('');
    try {
      await freezeVersion.mutateAsync({
        contractId: selectedContract.id,
        version: version.trim(),
        notes: notes.trim() || '契约兼容性评审完成，正式冻结。',
        request: revisionRequest(
          {
            revision: selectedContract.revision,
            basisVersion: selectedContract.basisVersion,
          },
          'freeze-release',
        ),
      });
      setVersion('');
      setNotes('');
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        setConflict({
          currentRevision: error.currentRevision,
          currentBasisVersion: error.currentBasisVersion,
        });
      } else if (error instanceof StorageWriteError) {
        setNotice('写入失败，冻结批次已保留，可在顶部横幅重试（不会重复生成版本）。');
      } else {
        setNotice(error instanceof Error ? error.message : '冻结失败');
      }
    }
  }

  return (
    <div>
      <PendingRecoveryBanner />
      {conflict && (
        <ConflictDialog
          open
          currentRevision={conflict.currentRevision}
          currentBasisVersion={conflict.currentBasisVersion}
          remoteChanges={[]}
          onRefresh={() => {
            setConflict(null);
            void contracts.refetch();
          }}
          onMerge={() => {
            setConflict(null);
            void contracts.refetch();
            setNotice('已刷新为最新修订，请确认门禁后重新冻结。');
          }}
        />
      )}

      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Release Center</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
          契约版本发布
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          只有逐条评审完成且迁移约束满足后，才能冻结正式版本。冻结时固化变更、调用方、豁免与校验值，
          冻结后的旧草稿不能再过发布门禁。
        </p>
      </div>

      {notice && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {notice}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>正式版本记录</CardTitle>
            <p className="mt-1 text-xs text-slate-500">{versions.length} 个冻结版本</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">契约</th>
                    <th className="px-4 py-3 font-medium">版本</th>
                    <th className="px-4 py-3 font-medium">发布时间</th>
                    <th className="px-4 py-3 font-medium">固化修订</th>
                    <th className="px-4 py-3 font-medium">校验值</th>
                    <th className="px-4 py-3 font-medium">发布说明</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {versions.map(({ contract, release }) => (
                    <tr key={release.id} className="border-t border-slate-100">
                      <td className="px-4 py-4">
                        <div className="font-medium">{contract.name}</div>
                        <div className="mt-1 text-xs text-slate-500">{contract.domain}</div>
                      </td>
                      <td className="px-4 py-4">
                        <Badge tone="slate">v{release.version}</Badge>
                      </td>
                      <td className="px-4 py-4 text-slate-600">
                        {formatDateTime(release.releasedAt)}
                      </td>
                      <td className="px-4 py-4 font-mono text-xs text-slate-600">
                        r{release.frozenRevision || '迁移补齐'}
                      </td>
                      <td className="px-4 py-4 font-mono text-xs text-slate-600">
                        {release.checksum}
                        {release.snapshotStatus === 'legacy' && (
                          <span className="ml-1 text-[10px] text-slate-400">历史</span>
                        )}
                      </td>
                      <td className="max-w-md px-4 py-4 text-slate-600">{release.notes}</td>
                      <td className="px-4 py-4 text-right">
                        <Link
                          to="/contracts/$contractId"
                          params={{ contractId: contract.id }}
                          className="text-xs font-medium text-sky-800 hover:underline"
                        >
                          查看版本
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!versions.length && (
                <p className="px-4 py-16 text-center text-sm text-slate-500">
                  尚无冻结的正式版本。
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>选择发布候选</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                发布门禁基于{selectedView?.frozen ? '冻结有效版本' : '当前修订工作副本'}检查
              </p>
            </CardHeader>
            <CardContent>
              <Select
                value={selectedContractId}
                onValueChange={(value) => {
                  setSelectedContract(value);
                  const contract = (contracts.data ?? []).find((item) => item.id === value);
                  if (contract) setVersion(suggestVersion(contract.version));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择一个契约" />
                </SelectTrigger>
                <SelectContent>
                  {(contracts.data ?? []).map((contract) => (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contract.name} · v{contract.version} · r{contract.revision}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selectedContract && selectedView && (
                <div className="mt-4">
                  <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                    有效版本 v{selectedView.effectiveVersion} · 修订 r{selectedView.revision} ·
                    依据 {selectedView.basisVersion ? `v${selectedView.basisVersion}` : '首次发布'}
                  </div>
                  <div
                    className={
                      frozenSelected
                        ? 'flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3'
                        : blockers
                          ? 'flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3'
                          : 'flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3'
                    }
                  >
                    {frozenSelected ? (
                      <LockKeyhole className="mt-0.5 h-4 w-4 text-slate-500" />
                    ) : blockers ? (
                      <TriangleAlert className="mt-0.5 h-4 w-4 text-red-700" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />
                    )}
                    <div>
                      <strong className="text-sm">
                        {frozenSelected
                          ? '该契约已冻结'
                          : blockers
                            ? `${blockers} 个阻断项`
                            : '发布门禁通过'}
                      </strong>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {frozenSelected
                          ? '冻结时固化的变更、调用方、豁免和校验值不能再修改，请在详情页开启新草稿。'
                          : blockers
                            ? '先在详细页补齐改变评审、影响说明和迁移方案。'
                            : '可以冻结正式版本，保存冲突时会先列出对方变更。'}
                      </p>
                    </div>
                  </div>

                  {!frozenSelected && (
                    <>
                      <label className="mt-4 block text-xs font-medium text-slate-700">
                        新版本号
                      </label>
                      <Input
                        className="mt-1.5"
                        value={version}
                        onChange={(event) => setVersion(event.target.value)}
                        placeholder="2.9.0"
                      />
                      <label className="mt-4 block text-xs font-medium text-slate-700">
                        发布说明
                      </label>
                      <Textarea
                        className="mt-1.5"
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                        placeholder="版本变化、兼容层和调用方升级状态"
                      />
                      <Button
                        className="mt-4 w-full"
                        disabled={!!blockers || !version.trim() || freezeVersion.isPending}
                        onClick={() => void freeze()}
                      >
                        <LockKeyhole className="h-4 w-4" />
                        {freezeVersion.isPending ? '冻结中' : '冻结正式版本'}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>冻结策略</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-600">
              <Policy icon={Archive} text="版本快照包含完整 OpenAPI、变更、调用方与豁免清单。" />
              <Policy icon={PackageCheck} text="新版本发布不会覆盖旧版记录，冻结内容不可再改。" />
              <Policy icon={LockKeyhole} text="冻结后门禁与报告只认固化快照，旧草稿不能再次通过。" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function suggestVersion(current: string): string {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return current;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function Policy({
  icon: Icon,
  text,
}: {
  icon: typeof Archive;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-sky-800" />
      <span>{text}</span>
    </div>
  );
}
