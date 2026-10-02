import { Download, FileJson, FileText, Hash, ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { PendingRecoveryBanner } from '../components/contract/pending-recovery-banner';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { formatDateTime } from '../lib/utils';
import { effectiveView } from '../models/contract';
import { buildChangeReport } from '../services/contract-service';
import { useContracts } from '../services/contract-queries';
import { useReviewStore } from '../store/review-store';

export function ReportsPage() {
  const contracts = useContracts();
  const selectedContractId = useReviewStore((state) => state.selectedContractId);
  const setSelectedContract = useReviewStore((state) => state.setSelectedContract);
  const contract =
    (contracts.data ?? []).find((item) => item.id === selectedContractId) ??
    contracts.data?.[0];
  const view = contract ? effectiveView(contract) : undefined;

  const report = useMemo(() => (contract ? buildChangeReport(contract) : ''), [contract]);
  const reviewed = view?.changes.filter((change) => change.reviewState !== 'pending') ?? [];

  return (
    <div>
      <PendingRecoveryBanner />
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Change Report</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
            契约变更报告
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            汇总接口差异、兼容性结论、调用方影响、迁移方案和兼容层豁免。页面、门禁与报告显示同一有效版本。
          </p>
        </div>
        {contract && view && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                downloadText(
                  `${contract.id}-v${view.effectiveVersion}.json`,
                  JSON.stringify(contract, null, 2),
                  'application/json;charset=utf-8',
                )
              }
            >
              <FileJson className="h-4 w-4" />
              导出 JSON
            </Button>
            <Button
              onClick={() =>
                downloadText(
                  `${contract.id}-v${view.effectiveVersion}-r${view.revision}-change-report.md`,
                  report,
                  'text/markdown;charset=utf-8',
                )
              }
            >
              <Download className="h-4 w-4" />
              导出报告
            </Button>
          </div>
        )}
      </div>

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
          <span className="text-sm font-medium text-slate-700">选择契约</span>
          <Select
            value={contract?.id ?? ''}
            onValueChange={setSelectedContract}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue placeholder="选择契约" />
            </SelectTrigger>
            <SelectContent>
              {(contracts.data ?? []).map((item) => {
                const itemView = effectiveView(item);
                return (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · v{itemView.effectiveVersion} · r{itemView.revision}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {contract && view && (
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <Badge tone="blue">{contract.domain}</Badge>
              <Badge tone="neutral">{view.changes.length} 个变化</Badge>
              <Badge tone={view.frozen ? 'slate' : reviewed.length === view.changes.length ? 'green' : 'amber'}>
                {view.frozen
                  ? `已冻结 v${view.effectiveVersion}`
                  : reviewed.length === view.changes.length
                    ? '评审完成'
                    : '仍有待评审项'}
              </Badge>
              <Badge tone="neutral">
                <Hash className="mr-1 h-3 w-3" />
                r{view.revision}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {contract && view ? (
        <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>报告预览</CardTitle>
                <p className="mt-1 text-xs text-slate-500">Markdown 归档格式</p>
              </div>
              <FileText className="h-5 w-5 text-slate-400" />
            </CardHeader>
            <CardContent>
              <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100">
                {report}
              </pre>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>豁免记录{view.frozen ? '（冻结快照）' : ''}</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  兼容层范围、原因、到期时间、登记修订与依据版本会进入正式报告
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {view.exemptions.map((exemption) => (
                  <article
                    key={exemption.id}
                    className="rounded-md border border-blue-200 bg-blue-50 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-sm text-blue-950">{exemption.scope}</strong>
                      <Badge tone="blue">至 {exemption.expiresAt}</Badge>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-blue-900">{exemption.reason}</p>
                    <div className="mt-2 text-[11px] text-blue-800">
                      批准人：{exemption.approvedBy} · 登记 r{exemption.revision} · 依据{' '}
                      {exemption.basisVersion ? `v${exemption.basisVersion}` : '首次发布'}
                    </div>
                  </article>
                ))}
                {!view.exemptions.length && (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                    当前没有兼容层豁免。
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>评审签名</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {view.changes.map((change) => (
                  <div
                    key={change.id}
                    className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0"
                  >
                    <div>
                      <div className="font-mono text-[11px] text-slate-600">
                        {change.method} {change.path}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {change.reviewer || '尚未评审'}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-slate-400">
                        依据 r{change.reviewBasisRevision || '迁移补齐'} /{' '}
                        {change.reviewBasisVersion
                          ? `v${change.reviewBasisVersion}`
                          : '首次发布'}
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge
                        tone={
                          change.reviewState === 'accepted'
                            ? 'green'
                            : change.reviewState === 'returned'
                              ? 'red'
                              : change.reviewState === 'exemption'
                                ? 'blue'
                                : 'amber'
                        }
                      >
                        {change.reviewState}
                      </Badge>
                      {change.reviewedAt && (
                        <div className="mt-1 text-[10px] text-slate-400">
                          {formatDateTime(change.reviewedAt)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="flex items-start gap-3 rounded-md border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              有效版本为{view.frozen ? '冻结快照' : '当前修订工作副本'}（v{view.effectiveVersion} / r
              {view.revision}），校验值 {view.checksum}。冻结后页面、发布门禁与报告统一只认该版本。
            </div>
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="py-16 text-center text-sm text-slate-500">
            暂无可生成报告的契约。
          </CardContent>
        </Card>
      )}
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
