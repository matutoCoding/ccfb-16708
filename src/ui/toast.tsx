/** 轻量全局提示 */
import { create } from 'zustand';

interface ToastState {
  message: string;
  kind: 'info' | 'ok' | 'bad';
  show: (message: string, kind?: 'info' | 'ok' | 'bad') => void;
  hide: () => void;
}

export const useToast = create<ToastState>((set) => ({
  message: '',
  kind: 'info',
  show(message, kind = 'info') {
    set({ message, kind });
    setTimeout(() => set({ message: '' }), 3200);
  },
  hide() { set({ message: '' }); }
}));

export function ToastHost() {
  const { message, kind } = useToast();
  if (!message) return null;
  return <div className={`toast ${kind === 'info' ? '' : kind}`}>{message}</div>;
}
