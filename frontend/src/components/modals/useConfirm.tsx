/**
 * useConfirm — an in-page "are you sure?" dialog (2026-10-06).
 *
 * "các nút chọn xoá hay xoá tất cả đều ko dùng được": the browser's own
 * window.confirm() is blocked or silently answers "no" inside other apps'
 * browsers (the Google app, Zalo…), which is where teachers open the site on
 * their phones — so every delete did nothing. This dialog is part of the page
 * and works everywhere.
 *
 *   const [confirmDialog, confirm] = useConfirm();
 *   if (!(await confirm('Xoá 3 phiếu?', { danger: true, okLabel: 'Xoá' }))) return;
 *   …
 *   return <>{…}{confirmDialog}</>;
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import Modal from './Modal';
import Button from '../common/Button';

interface Options { title?: string; okLabel?: string; cancelLabel?: string; danger?: boolean }

export function useConfirm(): [ReactNode, (message: ReactNode, opts?: Options) => Promise<boolean>] {
  const [state, setState] = useState<{ message: ReactNode; opts: Options } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((message: ReactNode, opts: Options = {}) => new Promise<boolean>(resolve => {
    resolver.current?.(false);
    resolver.current = resolve;
    setState({ message, opts });
  }), []);

  const close = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState(null);
  };

  const dialog = (
    <Modal open={state !== null} onClose={() => close(false)} title={state?.opts.title ?? 'Xác nhận'} width={420}
      footer={<>
        <Button variant="secondary" onClick={() => close(false)}>{state?.opts.cancelLabel ?? 'Hủy'}</Button>
        <Button variant={state?.opts.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
          {state?.opts.okLabel ?? 'Đồng ý'}
        </Button>
      </>}>
      <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.6 }}>{state?.message}</div>
    </Modal>
  );
  return [dialog, confirm];
}
