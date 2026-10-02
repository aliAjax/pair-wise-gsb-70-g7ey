import { Link } from '@tanstack/react-router';
import { Archive, CheckCircle2, FilePlus2, LockKeyhole, PackageCheck, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { validateForRelease } from '../models/contract';
import { effectiveView, FrozenContractError, releaseIssues } from '../models/revision-engine';
import { isConflictError } from '../components/contract/use-conflict-state';
import {
  useContracts,
  useFreezeVersion,
  useStartNewDraft,
} from '../services/contract-queries';
import { useReviewStore } from '../store/review-store';

export function ReleasesPage() {
  const contracts = useContracts();
  const freezeVersion = useFreezeVersion();
  const startNewDraft = useStartNewDraft();
  const selectedContractId = useReviewStore((state) => state.selectedContractId);
  const setSelectedContract = useReviewStore((state) => state.setSelectedContract);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const selectedContract = (contracts.data ?? []).find(
    (contract) => contract.id === selectedContractId,
  );
  const selectedView = selectedContract ? effectiveView(selectedContract) : null;
  const selectedIssues = selectedContract
    ? releaseIssues(selectedContract, validateForRelease(selectedContract))
    : [];
  const blockers = selectedIssues.filter((issue) => issue.severity === 'blocker').length;

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
    if (!selectedContract || !version.trim() || blockers) return;
    setError('');
    try {
      await freezeVersion.mutateAsync({
        contractId: selectedContract.id,
        version: version.trim(),
        notes: notes.trim() || '契约兼容性评审完成，正式冻结。',
        expectedRevision: selectedContract.revision,
      });
      setVersion('');
      setNotes('');
    } catch (caught) {
      if (isConflictError(caught)) {
        setError(`契约已被另一会话更新到修订 ${caught.currentRevision}，请刷新候选后再冻结。`);
        return;
      }
      setError(
        caught instanceof FrozenContractError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : '冻结失败，改动已保留在待恢复批次。',
      );
    }
  }

  async function beginDraft() {
    if (!selectedContract) return;
    setError('');
    try {
      await startNewDraft.mutateAsync({
        contractId: selectedContract.id,
        expectedRevision: selectedContract.revision,
      });
    } catch (caught) {
      if (isConflictError(caught)) {
        setError(`契约已被另一会话更新到修订 ${caught.currentRevision}，请刷新后再发起草稿。`);
        return;
      }
      setError(caught instanceof Error ? caught.message : '发起草稿失败。');
    }
  }

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Release Center</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
          契约版本发布
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          只有逐条评审完成、审核依据有效且迁移约束满足后，才能冻结正式版本。冻结固化变更、调用方、豁免与校验值；冻结后的旧草稿不能再过门禁。
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>正式版本记录</CardTitle>
            <p className="mt-1 text-xs text-slate-500">{versions.length} 个冻结版本</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">契约</th>
                    <th className="px-4 py-3 font-medium">版本</th>
                    <th className="px-4 py-3 font-medium">发布时间</th>
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
                        {release.checksum}
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
                发布门禁检查当前工作副本（r{selectedContract?.revision ?? '-'}，依据 v
                {selectedContract?.basisVersion || '无'}）
              </p>
            </CardHeader>
            <CardContent>
              <Select
                value={selectedContractId}
                onValueChange={(value) => {
                  setSelectedContract(value);
                  const contract = (contracts.data ?? []).find((item) => item.id === value);
                  if (contract) setVersion(suggestVersion(contract.version));
                  setError('');
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择一个契约" />
                </SelectTrigger>
                <SelectContent>
                  {(contracts.data ?? []).map((contract) => (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contract.name} · v{contract.version}
                      {contract.status === 'frozen' ? '（已冻结）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selectedContract && selectedView && (
                <div className="mt-4">
                  <div
                    className={
                      blockers
                        ? 'flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3'
                        : 'flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3'
                    }
                  >
                    {blockers ? (
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                    )}
                    <div>
                      <strong className="text-sm">
                        {selectedView.isFrozen
                          ? `有效版本 v${selectedView.frozenVersion} 已冻结`
                          : blockers
                            ? `${blockers} 个阻断项`
                            : '发布门禁通过'}
                      </strong>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {selectedView.isFrozen
                          ? '冻结后的旧草稿不能继续发布，请基于该版本发起新一版草稿。'
                          : blockers
                            ? selectedIssues.find((issue) => issue.severity === 'blocker')?.detail
                            : '可以冻结正式版本，历史工作副本仍保留。'}
                      </p>
                    </div>
                  </div>

                  {selectedView.isFrozen && (
                    <Button
                      className="mt-3 w-full"
                      variant="secondary"
                      disabled={startNewDraft.isPending}
                      onClick={() => void beginDraft()}
                    >
                      <FilePlus2 className="h-4 w-4" />
                      基于 v{selectedView.frozenVersion} 发起新草稿
                    </Button>
                  )}

                  {!selectedView.isFrozen && (
                    <>
                      <label className="mt-4 block text-xs font-medium text-slate-700">新版本号</label>
                      <Input
                        className="mt-1.5"
                        value={version}
                        onChange={(event) => setVersion(event.target.value)}
                        placeholder="2.9.0"
                      />
                      <label className="mt-4 block text-xs font-medium text-slate-700">发布说明</label>
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

                  {error && <p className="mt-3 text-xs leading-5 text-red-700">{error}</p>}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>冻结策略</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-600">
              <Policy icon={Archive} text="版本快照固化完整 OpenAPI、变更结论、调用方与豁免，并记录整体校验值。" />
              <Policy icon={PackageCheck} text="新版本发布不会覆盖旧版记录；冻结请求按幂等键重试，不重复生成版本。" />
              <Policy icon={LockKeyhole} text="冻结后的旧草稿不能通过发布门禁，必须基于有效版本发起新一版草稿。" />
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
