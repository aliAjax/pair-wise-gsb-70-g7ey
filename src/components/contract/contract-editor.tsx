import Editor from '@monaco-editor/react';
import { LockKeyhole, Save } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/button';
import type { ApiContract } from '../../models/contract';

interface ContractEditorProps {
  contract: ApiContract;
  frozen: boolean;
  onSave: (value: string) => void;
  saving: boolean;
}

export function ContractEditor({ contract, frozen, onSave, saving }: ContractEditorProps) {
  // key 中带修订号：其他窗口保存或冲突合并后整组件重挂载，输入同步到最新修订
  const [value, setValue] = useState(contract.openapi);

  return (
    <div className="overflow-hidden rounded-md border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div>
          <span className="text-xs font-medium text-slate-700">OpenAPI 源定义</span>
          <span className="ml-2 text-[11px] text-slate-500">Monaco Editor</span>
          {frozen && (
            <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-slate-500">
              <LockKeyhole className="h-3 w-3" />
              冻结版本只读
            </span>
          )}
        </div>
        {!frozen && (
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
        value={frozen ? contract.openapi : value}
        onChange={(nextValue) => setValue(nextValue ?? '')}
        options={{
          readOnly: frozen,
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
