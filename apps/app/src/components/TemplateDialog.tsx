import { For, Show } from 'solid-js';
import { Bookmark, Trash2 } from 'lucide-solid';
import type { TaskTemplate } from '../lib/templates';
import { Modal } from './Modal';

interface TemplateDialogProps {
  open: boolean;
  templates: TaskTemplate[];
  onClose: () => void;
  onUse: (template: TaskTemplate) => void;
  onDelete: (id: string) => void;
}

export function TemplateDialog(props: TemplateDialogProps) {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="任务模板"
      size="md"
      class="template-modal"
    >
      <div class="template-list">
        <Show
          when={props.templates.length > 0}
          fallback={
            <p class="template-empty">还没有模板。打开任务详情，点击右上角的书签按钮即可保存。</p>
          }
        >
          <For each={props.templates}>
            {(template) => (
              <div class="template-row">
                <div class="template-row__icon">
                  <Bookmark size={16} />
                </div>
                <div class="template-row__body">
                  <strong>{template.name}</strong>
                  <span>
                    {template.title}
                    {template.tags.length > 0 ? ` · #${template.tags.join(' #')}` : ''}
                    {template.steps.length > 0 ? ` · ${template.steps.length} 个步骤` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  class="secondary-button"
                  onClick={() => {
                    props.onUse(template);
                    props.onClose();
                  }}
                >
                  使用
                </button>
                <button
                  type="button"
                  class="icon-button icon-button--small danger-text"
                  aria-label={`删除模板 ${template.name}`}
                  onClick={() => props.onDelete(template.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Modal>
  );
}
