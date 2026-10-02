import { useCallback, useMemo, useState } from 'react';
import type { RevisionConflictError } from '../../models/revision-engine';

export interface ConflictState {
  currentRevision: number;
  expectedRevision: number;
  basisVersion: string;
  remoteRevisions: RevisionConflictError['remoteRevisions'];
  conflicts: RevisionConflictError['conflicts'];
}

export function isConflictError(error: unknown): error is RevisionConflictError {
  return error instanceof Error && error.name === 'RevisionConflictError';
}

/**
 * 管理乐观并发冲突状态：捕获 RevisionConflictError，
 * 记录对方修订与冲突字段，页面据此弹出合并对话框。
 */
export function useConflictState() {
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [chosenMine, setChosenMine] = useState<Set<string>>(new Set());

  const capture = useCallback((error: unknown): boolean => {
    if (isConflictError(error)) {
      setConflict({
        currentRevision: error.currentRevision,
        expectedRevision: error.expectedRevision,
        basisVersion: error.basisVersion,
        remoteRevisions: error.remoteRevisions,
        conflicts: error.conflicts,
      });
      // 默认全部采用对方；用户可逐项切换为保留本地
      setChosenMine(new Set());
      return true;
    }
    return false;
  }, []);

  const toggleChoice = useCallback((field: string) => {
    setChosenMine((previous) => {
      const next = new Set(previous);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }, []);

  const close = useCallback(() => setConflict(null), []);

  return useMemo(
    () => ({ conflict, chosenMine, capture, toggleChoice, close, setConflict }),
    [conflict, chosenMine, capture, toggleChoice, close],
  );
}
