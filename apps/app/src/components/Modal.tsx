import { createEffect, createUniqueId, onCleanup, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { X } from 'lucide-solid';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  ariaLabel?: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  bare?: boolean;
  children: JSX.Element;
  class?: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal(props: ModalProps) {
  let dialog!: HTMLDivElement;
  let restoreFocus: HTMLElement | null = null;
  const titleId = createUniqueId();

  createEffect(() => {
    if (!props.open) return;
    restoreFocus = document.activeElement as HTMLElement | null;
    document.body.classList.add('modal-open');
    const frame = requestAnimationFrame(() => {
      const first = dialog?.querySelector<HTMLElement>('[autofocus], ' + FOCUSABLE);
      first?.focus();
    });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => item.offsetParent !== null,
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', handleKey);
      restoreFocus?.focus?.();
    });
  });

  return (
    <Portal>
      <Show when={props.open}>
        <div
          class="modal-layer"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) props.onClose();
          }}
        >
          <div
            ref={dialog}
            class={`modal modal--${props.size ?? 'md'} ${props.bare ? 'modal--bare' : ''} ${
              props.class ?? ''
            }`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={props.title ? titleId : undefined}
            aria-label={!props.title ? props.ariaLabel : undefined}
          >
            <Show when={!props.bare}>
              <header class="modal__header">
                <div>
                  <Show when={props.title}>
                    <h2 id={titleId}>{props.title}</h2>
                  </Show>
                  <Show when={props.description}>
                    <p class="modal__description">{props.description}</p>
                  </Show>
                </div>
                <button type="button" class="icon-button" onClick={props.onClose} aria-label="关闭">
                  <X size={18} />
                </button>
              </header>
            </Show>
            {props.children}
          </div>
        </div>
      </Show>
    </Portal>
  );
}
