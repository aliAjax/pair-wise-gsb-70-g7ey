import {
  AlertTriangle,
  CheckCircle2,
  HardDriveDownload,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
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
import {
  useDiscardPendingWrite,
  useFailureInjection,
  usePendingWrites,
  useReplayPendingWrites,
  type PendingWrite,
} from '../../services/contract-queries';

const KIND_LABELS: Record<PendingWrite['kind'], string> = {
  save: '保存草稿',
  openapi: '编辑契约定义',
  review: '提交评审',
  bulk_review: '批量评审',
  exemption: '登记豁免',
  freeze: '冻结版本',
  start_draft: '发起新草稿',
};

export function RecoveryCenter() {
  const pending = usePendingWrites();
  const replay = useReplayPendingWrites();
  const discard = useDiscardPendingWrite();
  const failureInjection = useFailureInjection();
  const [open, setOpen] = useState(false);
  const [resultMessage, setResultMessage] = useState('');

  const writes = pending.data ?? [];

  async function handleReplay() {
    setResultMessage('');
    const result = await replay.mutateAsync();
    if (!result.failed.length) {
      setResultMessage(`已恢复 ${result.succeeded.length} 个批次。`);
    } else {
      setResultMessage(
        `恢复 ${result.succeeded.length} 个，${result.failed.length} 个仍需处理：${result.failed[0].error}`,
      );
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        title="写入失败时，改动会保留在待恢复批次，可在此重试"
      >
        <HardDriveDownload className="h-3.5 w-3.5" />
        待恢复
        {writes.length > 0 && (
          <span className="ml-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {writes.length}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(720px,calc(100vw-32px))]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HardDriveDownload className="h-5 w-5 text-sky-700" />
              待恢复写入批次
            </DialogTitle>
            <DialogDescription>
              写入本地存储失败的改动会先保留下来，不会丢失。重试按原请求标识幂等执行，
              <strong>不会重复生成正式版本或兼容层豁免</strong>。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {writes.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                <CheckCircle2 className="h-4 w-4" />
                没有待恢复批次，所有改动均已写入。
              </div>
            ) : (
              writes.map((write) => (
                <div
                  key={write.id}
                  className="rounded-md border border-slate-200 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge tone="amber">{KIND_LABELS[write.kind]}</Badge>
                      <span className="text-xs text-slate-500">
                        修订 r{write.baseRevision ?? '?'} · {write.actor}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400">
                      {formatDateTime(write.createdAt)} · 已重试 {write.attempts} 次
                    </span>
                  </div>
                  {write.lastError && (
                    <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-red-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {write.lastError}
                    </p>
                  )}
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => discard.mutate(write.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      丢弃
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          {resultMessage && (
            <p className="mt-3 text-xs text-slate-600">{resultMessage}</p>
          )}

          <div className="mt-4 flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                defaultChecked={false}
                onChange={(event) => failureInjection.mutate(event.target.checked)}
              />
              演示模式：让下一次写入失败（进入待恢复批次）
            </label>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
                关闭
              </Button>
              <Button onClick={() => void handleReplay()} disabled={!writes.length || replay.isPending}>
                <RotateCw className="h-4 w-4" />
                {replay.isPending ? '恢复中' : `重试全部（${writes.length}）`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
