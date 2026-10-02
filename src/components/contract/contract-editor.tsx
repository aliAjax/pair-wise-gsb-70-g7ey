import Editor from '@monaco-editor/react';
import { LockKeyhole, Save } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/button';
import type { ApiContract } from '../../models/contract';

interface ContractEditorProps {
  contract: ApiContract;
  onSave: (value: string) => void;
  saving: boolean;
  readOnly?: boolean;
  /** 当前编辑所基于的修订号，展示给维护者 */
  revision?: number;
}

export function ContractEditor({ contract, onSave, saving, readOnly = false, revision }: ContractEditorProps) {
  const [value, setValue] = useState(contract.openapi);

  return (
    <div className="overflow-hidden rounded-md border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div>
          <span className="text-xs font-medium text-slate-700">OpenAPI 源定义</span>
          <span className="ml-2 text-[11px] text-slate-500">Monaco Editor</span>
          {revision !== undefined && (
            <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
              r{revision}
            </span>
          )}
          {readOnly && (
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-slate-500">
              <LockKeyhole className="h-3 w-3" />
              冻结快照只读
            </span>
          )}
        </div>
        {!readOnly && (
          <Button
            size="sm"
            variant="secondary"
            disabled={saving || value === contract.openapi}
            onClick={() => onSave(value)}
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? '保存中' : '保存定义'}
          </Button>
        )}
      </div>
      <Editor
        height="430px"
        language="plaintext"
        theme="vs"
        value={value}
        onChange={(nextValue) => !readOnly && setValue(nextValue ?? '')}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          lineHeight: 20,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
        }}
      />
    </div>
  );
}
