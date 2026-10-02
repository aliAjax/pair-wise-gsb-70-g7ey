import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ReviewState } from '../models/contract';
import {
  addExemption,
  discardPendingWrite,
  freezeVersion,
  getContract,
  listContracts,
  listPendingWrites,
  replayPendingWrites,
  reviewChange,
  saveContract,
  setFailNextWrites,
  startNewDraft,
  updateContractOpenApi,
  bulkReviewChanges,
  type PendingWrite,
  type SaveContractInput,
  type ReviewInput,
  type BulkReviewInput,
  type UpdateOpenApiInput,
  type ExemptionInput,
  type FreezeInput,
  type StartDraftInput,
} from './contract-service';

export const contractKeys = {
  all: ['contracts'] as const,
  detail: (id: string) => ['contracts', id] as const,
  pending: ['pending-writes'] as const,
};

export function useContracts() {
  return useQuery({
    queryKey: contractKeys.all,
    queryFn: listContracts,
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: contractKeys.detail(id),
    queryFn: () => getContract(id),
    enabled: Boolean(id),
  });
}

/** 跨标签页：任一标签页写入后，其它标签页自动刷新为当前修订 */
function useStorageSync() {
  const queryClient = useQueryClient();
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === 'pair-wise-gsb-70-contracts' || event.key === null) {
        void queryClient.invalidateQueries({ queryKey: contractKeys.all });
      }
      if (event.key === 'pair-wise-gsb-70-write-meta' || event.key === null) {
        void queryClient.invalidateQueries({ queryKey: contractKeys.pending });
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [queryClient]);
}

export function usePendingWrites() {
  useStorageSync();
  return useQuery({
    queryKey: contractKeys.pending,
    queryFn: async () => listPendingWrites(),
    staleTime: 0,
  });
}

export function useReplayPendingWrites() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => replayPendingWrites(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contractKeys.all });
      void queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useDiscardPendingWrite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      discardPendingWrite(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useFailureInjection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      setFailNextWrites(enabled);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useReviewChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewInput) => reviewChange(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useBulkReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkReviewInput) => bulkReviewChanges(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useUpdateOpenApi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOpenApiInput) => updateContractOpenApi(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useSaveContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveContractInput) => saveContract(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useAddExemption() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExemptionInput) => addExemption(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useFreezeVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FreezeInput) => freezeVersion(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useStartNewDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartDraftInput) => startNewDraft(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

// 保留原类型导出，方便页面引用
export type {
  BulkReviewInput,
  ExemptionInput,
  FreezeInput,
  PendingWrite,
  ReviewInput,
  SaveContractInput,
  StartDraftInput,
  UpdateOpenApiInput,
};
export type { ReviewState };
