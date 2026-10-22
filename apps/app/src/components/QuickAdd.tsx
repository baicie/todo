import { createSignal, Show } from 'solid-js';
import { ArrowUp, Bookmark, CalendarDays, Plus, Sparkles } from 'lucide-solid';

interface QuickAddProps {
  placeholder?: string;
  listId: string | null;
  inputRef?: (element: HTMLInputElement) => void;
  onAdd: (text: string) => Promise<void>;
  onOpenTemplates?: () => void;
}

export function QuickAdd(props: QuickAddProps) {
  const [text, setText] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let input!: HTMLInputElement;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = text().trim();
    if (!value || busy()) return;
    setBusy(true);
    try {
      await props.onAdd(value);
      setText('');
      input.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="quick-add" onSubmit={(event) => void submit(event)}>
      <span class="quick-add__plus" aria-hidden="true">
        <Plus size={19} stroke-width={2.2} />
      </span>
      <input
        ref={(element) => {
          input = element;
          props.inputRef?.(element);
        }}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        class="quick-add__input"
        placeholder={props.placeholder ?? '添加任务，按 Enter 保存'}
        aria-label="添加任务"
        autocomplete="off"
        maxlength={1000}
      />
      <div class="quick-add__hints" aria-hidden="true">
        <Show
          when={
            text().includes('今天') ||
            text().includes('明天') ||
            text().includes('周') ||
            text().includes('每天')
          }
        >
          <span class="quick-add__hint">
            <CalendarDays size={13} /> 自动识别日期
          </span>
        </Show>
        <Show when={text().includes('#')}>
          <span class="quick-add__hint">
            <Sparkles size={13} /> 自动识别标签
          </span>
        </Show>
        <Show when={text().includes('@')}>
          <span class="quick-add__hint">
            <Sparkles size={13} /> 指定清单
          </span>
        </Show>
      </div>
      <button
        type="button"
        class="icon-button icon-button--small quick-add__template"
        aria-label="从模板创建"
        title="从模板创建"
        onClick={props.onOpenTemplates}
      >
        <Bookmark size={15} />
      </button>
      <button
        type="submit"
        class="quick-add__submit"
        classList={{ 'quick-add__submit--visible': Boolean(text().trim()) }}
        aria-label="保存任务"
        disabled={!text().trim() || busy()}
      >
        <ArrowUp size={17} stroke-width={2.4} />
      </button>
    </form>
  );
}
