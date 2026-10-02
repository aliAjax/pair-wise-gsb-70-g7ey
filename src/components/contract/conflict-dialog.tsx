import { GitMerge, RefreshCw } from 'lucide-react';
import { formatDateTime } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import type {
  FieldConflict,
  RemoteRevision,
} from '../../models/revision-engine';

interface ConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentRevision: number;
  expectedRevision: number;
  basisVersion: string;
  remoteRevisions: RemoteRevision[];
  conflicts: FieldConflict[];
  /** 已选择采用本地值的冲突字段 */
  chosenMine: Set<string>;
  onToggleChoice: (field: string) => void;
  onConfirm: () => void;
  onRefresh: () => void;
  submitting?: boolean;
}

const ACTION_LABELS: Record<RemoteRevision['action'], string> = {
  migrated: '数据迁移',
  draft_save: '保存草稿',
  openapi_edit: '编辑定义',
  review: '提交评审',
  bulk_review: '批量评审',
  exemption: '登记豁免',
  freeze: '冻结版本',
  start_draft: '发起新草稿',
};

/** 冲突方先列出对方变更，再逐字段选择采用对方还是本地，最后合并提交 */
export function ConflictDialog({
  open,
  onOpenChange,
  currentRevision,
  expectedRevision,
  basisVersion,
  remoteRevisions,
  conflicts,
  chosenMine,
  onToggleChoice,
  onConfirm,
  onRefresh,
  submitting,
}: ConflictDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(860px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5 text-amber-600" />
            检测到并发修订，需要先合并
          </DialogTitle>
          <DialogDescription>
            你的标签页基于修订号 {expectedRevision}，另一个评审会话已把契约更新到修订号{' '}
            {currentRevision}
            {basisVersion ? `（依据版本 v${basisVersion}）` : ''}
            。请先查看对方变更，再对每个冲突字段选择保留哪一方。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="rounded-md border border-sky-200 bg-sky-50 p-3">
            <h4 className="text-xs font-semibold text-sky-900">
              对方在你打开之后提交的修订
            </h4>
            <ul className="mt-2 space-y-2">
              {remoteRevisions.length ? (
                remoteRevisions.map((revision) => (
                  <li key={revision.revision} className="flex items-start gap-2 text-xs">
                    <Badge tone="blue">r{revision.revision}</Badge>
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900">
                        {ACTION_LABELS[revision.action]} · {revision.actor}
                      </div>
                      <div className="mt-0.5 leading-5 text-slate-600">
                        {revision.summary}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        {formatDateTime(revision.at)}
                      </div>
                    </div>
                  </li>
                ))
              ) : (
                <li className="text-xs text-slate-500">
                  没有逐条审计记录（可能由旧版本写入），但修订号已变化。
                </li>
              )}
            </ul>
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-semibold text-slate-700">
              冲突字段（{conflicts.length}）
            </h4>
            {conflicts.map((conflict) => {
              const useMine = chosenMine.has(conflict.field);
              return (
                <div
                  key={conflict.field}
                  className="rounded-md border border-slate-200 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-xs text-slate-900">{conflict.label}</strong>
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant={useMine ? 'outline' : 'default'}
                        onClick={() => {
                          if (useMine) onToggleChoice(conflict.field);
                        }}
                      >
                        采用对方
                      </Button>
                      <Button
                        size="sm"
                        variant={useMine ? 'default' : 'outline'}
                        onClick={() => {
                          if (!useMine) onToggleChoice(conflict.field);
                        }}
                      >
                        保留我的
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2">
                    <div className="rounded border border-slate-200 bg-slate-50 p-2">
                      <div className="mb-1 font-semibold text-slate-500">
                        对方（修订 {currentRevision}）
                      </div>
                      <p
                        className={
                          useMine
                            ? 'whitespace-pre-wrap leading-4 text-slate-400 line-through'
                            : 'whitespace-pre-wrap leading-4 text-slate-800'
                        }
                      >
                        {conflict.theirs}
                      </p>
                    </div>
                    <div className="rounded border border-amber-200 bg-amber-50 p-2">
                      <div className="mb-1 font-semibold text-amber-700">我的改动</div>
                      <p
                        className={
                          useMine
                            ? 'whitespace-pre-wrap leading-4 text-amber-950'
                            : 'whitespace-pre-wrap leading-4 text-amber-600/60 line-through'
                        }
                      >
                        {conflict.mine}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
            放弃本地改动并刷新
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              稍后处理
            </Button>
            <Button onClick={onConfirm} disabled={submitting}>
              <GitMerge className="h-4 w-4" />
              {submitting ? '合并提交中' : '按选择合并并提交'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
