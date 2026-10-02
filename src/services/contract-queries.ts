import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewState } from '../models/contract';
import {
  addExemption,
  bulkReviewChanges,
  discardPendingOperation,
  freezeVersion,
  getContract,
  listContracts,
  listPendingOperations,
  recoverPendingOperations,
  reviewChange,
  saveChangeFields,
  saveContract,
  startNewDraft,
  updateContractOpenApi,
  type PendingOperation,
} from './contract-service';
import type { MergeableSave, RevisionRequest } from './revision-control';

export const contractKeys = {
  all: ['contracts'] as const,
  detail: (id: string) => ['contracts', id] as const,
  pending: ['pending-operations'] as const,
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

export interface ChangeFieldsInput {
  contractId: string;
  changeId: string;
  baseValues: Partial<Record<string, string>>;
  patch: MergeableSave['patch'];
  request: RevisionRequest;
}

export function useSaveChangeFields() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangeFieldsInput) =>
      saveChangeFields(
        input.contractId,
        input.changeId,
        input.baseValues,
        input.patch,
        input.request,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useReviewChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      state: ReviewState;
      reviewer: string;
      comment: string;
      request: RevisionRequest;
    }) =>
      reviewChange(
        input.contractId,
        input.changeId,
        input.state,
        input.reviewer,
        input.comment,
        input.request,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useBulkReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      selections: Array<{ contractId: string; changeId: string }>;
      state: ReviewState;
      reviewer: string;
      comment: string;
      bases: Record<string, { revision: number; basisVersion: string }>;
      request: RevisionRequest;
    }) =>
      bulkReviewChanges(
        input.selections,
        input.state,
        input.reviewer,
        input.comment,
        input.bases,
        input.request,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useUpdateOpenApi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      openapi: string;
      request: RevisionRequest;
    }) => updateContractOpenApi(input.contractId, input.openapi, input.request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useAddExemption() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      reason: string;
      request: RevisionRequest;
    }) => addExemption(input.contractId, input.changeId, input.reason, input.request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useFreezeVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      version: string;
      notes: string;
      request: RevisionRequest;
    }) => freezeVersion(input.contractId, input.version, input.notes, input.request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useStartNewDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      nextVersion: string;
      request: RevisionRequest;
    }) => startNewDraft(input.contractId, input.nextVersion, input.request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useSaveContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveContract,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function usePendingOperations() {
  return useQuery({
    queryKey: contractKeys.pending,
    queryFn: (): PendingOperation[] => listPendingOperations(),
    staleTime: 0,
  });
}

export function useRecoverPending() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: recoverPendingOperations,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: contractKeys.all });
      queryClient.invalidateQueries({ queryKey: contractKeys.pending });
    },
  });
}

export function useDiscardPending() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => discardPendingOperation(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.pending }),
  });
}

/** 生成幂等操作 id（同一次点击重试保持一致，由调用方在一次提交生命周期内保存） */
export function createOperationId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
