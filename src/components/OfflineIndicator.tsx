import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus.ts';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-[#EF4444]/15 border-b border-[#EF4444]/35 px-4 py-2 text-xs text-[#FCA5A5] flex items-center justify-center gap-2"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0 text-[#EF4444]" />
      <span>
        Mode Offline — Koneksi internet terputus. Feed XAU/USD real-time & AI Judge dijeda hingga jaringan kembali aktif.
      </span>
    </div>
  );
};
