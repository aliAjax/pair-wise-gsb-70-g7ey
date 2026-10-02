import { HardDriveDownload, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import {
  useDiscardPending,
  usePendingOperations,
  useRecoverPending,
} from '../../services/contract-queries';

const TYPE_LABELS: Record<string, string> = {
  fields: '影响/迁移说明',
  openapi: '契约定义',
  review: '评审结论',
  bulk_review: '批量评审',
  exemption: '兼容层豁免',
  freeze: '版本冻结',
  new_draft: '开启新草稿',
};

/**
 * 写入失败后保留的待恢复批次横幅。
 * 重试走幂等提交：已经成功过的版本/豁免不会重复生成。
 */
export function PendingRecoveryBanner() {
  const pending = usePendingOperations();
  const recover = useRecoverPending();
  const discard = useDiscardPending();
  const operations = pending.data ?? [];

  if (!operations.length) {
    return null;
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <HardDriveDownload className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div>
            <strong className="text-sm text-amber-950">
              有 {operations.length} 个写入批次因存储失败待恢复
            </strong>
            <p className="mt-1 text-xs leading-5 text-amber-800">
              改动已保留在本地待恢复队列，重试为幂等操作，不会重复生成版本号或豁免记录。
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => void recover.mutateAsync()}
          disabled={recover.isPending}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {recover.isPending ? '恢复中' : '立即重试全部'}
        </Button>
      </div>
      <ul className="mt-3 space-y-2">
        {operations.map((operation) => {
          const contractId =
            'contractId' in operation.payload ? operation.payload.contractId : '多个契约';
          return (
            <li
              key={operation.id}
              className="flex items-center justify-between gap-3 rounded border border-amber-200 bg-white px-3 py-2 text-xs"
            >
              <span className="text-slate-700">
                <strong>{TYPE_LABELS[operation.type] ?? operation.type}</strong>
                <span className="ml-2 font-mono text-slate-500">{contractId}</span>
              </span>
              <button
                type="button"
                className="text-slate-400 hover:text-red-600"
                aria-label="放弃该批次"
                onClick={() => discard.mutate(operation.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      {recover.data && recover.data.failed.length > 0 && (
        <p className="mt-2 text-xs text-red-700">
          {recover.data.failed.length} 个批次仍失败，可能已与最新修订冲突，请刷新页面后重新处理。
        </p>
      )}
    </div>
  );
}
