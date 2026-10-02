import { GitMerge, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import type { RemoteFieldChange } from '../../services/revision-control';
import { formatDateTime } from '../../lib/utils';

interface ConflictDialogProps {
  open: boolean;
  currentRevision: number;
  currentBasisVersion: string;
  remoteChanges: RemoteFieldChange[];
  onMerge: () => void;
  onRefresh: () => void;
}

/**
 * 乐观锁冲突对话框：
 * 先列出对方在自己保存之后提交的变更，再允许用户带着这些信息合并重试。
 */
export function ConflictDialog({
  open,
  currentRevision,
  currentBasisVersion,
  remoteChanges,
  onMerge,
  onRefresh,
}: ConflictDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onRefresh()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="h-5 w-5 text-amber-600" />
            保存冲突：契约已被另一个窗口更新
          </DialogTitle>
          <DialogDescription>
            当前有效修订为 r{currentRevision}
            {currentBasisVersion ? `（依据 v${currentBasisVersion}）` : '（首次发布）'}
            。你的修改基于更早的修订，系统没有接收。请先查看对方变更，再决定如何合并。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {remoteChanges.length ? (
            remoteChanges.map((item) => (
              <article
                key={`${item.changeId}-${item.field}`}
                className="rounded-md border border-amber-200 bg-amber-50 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm text-amber-950">
                    {item.path} · {item.label}
                  </strong>
                  <span className="text-[11px] text-amber-800">
                    {item.remoteAuthor} · r{item.remoteRevision} · {formatDateTime(item.remoteAt)}
                  </span>
                </div>
                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div className="rounded border border-slate-200 bg-white p-2">
                    <div className="mb-1 font-medium text-slate-500">你打开时的值</div>
                    <p className="whitespace-pre-wrap leading-5 text-slate-700">
                      {item.baseValue || '（空）'}
                    </p>
                  </div>
                  <div className="rounded border border-sky-200 bg-sky-50 p-2">
                    <div className="mb-1 font-medium text-sky-800">对方刚保存的值</div>
                    <p className="whitespace-pre-wrap leading-5 text-sky-950">
                      {item.remoteValue || '（空）'}
                    </p>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              对方更新了该契约的其他内容（如评审结论或契约定义），你的字段内容尚未被覆盖。
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onRefresh}>
            放弃修改，刷新为最新
          </Button>
          <Button onClick={onMerge}>
            <GitMerge className="h-4 w-4" />
            我已查看，带着对方变更合并重试
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
