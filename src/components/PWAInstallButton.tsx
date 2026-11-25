import React, { useState } from 'react';
import { Check, Copy, Download, Share, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall.ts';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, isInIframe, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  if (isInstalled) return null;

  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const handleCopyUrl = async () => {
    if (!appUrl) return;
    try {
      await navigator.clipboard.writeText(appUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handlePrimaryClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowGuide(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handlePrimaryClick()}
        title={isInstallable ? 'Install AurumEA di Android' : 'Cara akses & install di Android'}
        className={`inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] ${
          isInstallable
            ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/40 hover:bg-[#10B981]/25'
            : 'bg-[#111620] text-[#E6EDF3] border-white/[0.12] hover:border-[#D4AF37]/50 hover:text-[#D4AF37]'
        }`}
      >
        {isInstallable ? (
          <>
            <Download className="w-3.5 h-3.5" />
            <span>Install App</span>
          </>
        ) : (
          <>
            <Smartphone className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span className="hidden sm:inline">App Android</span>
            <span className="sm:hidden">Android</span>
          </>
        )}
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="android-install-title"
        >
          <div className="w-full max-w-md rounded-xl border border-white/[0.12] bg-[#111620] text-[#E6EDF3] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#D4AF37]/15 border border-[#D4AF37]/40 flex items-center justify-center">
                  <Smartphone className="w-4 h-4 text-[#D4AF37]" />
                </div>
                <div>
                  <h2 id="android-install-title" className="text-sm font-semibold text-[#F8FAFC]">
                    Akses & Install Aplikasi Android
                  </h2>
                  <p className="text-[11px] text-[#94A3B8]">
                    AurumEA PWA (Layar Penuh • Ikon Home Screen)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Tutup panduan"
                className="p-1.5 rounded-md text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-white/[0.06] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs leading-relaxed">
              {isInIframe && (
                <div className="rounded-lg border border-[#D4AF37]/30 bg-[#D4AF37]/10 p-3 text-[#F8FAFC]">
                  Browser memblokir prompt install otomatis saat aplikasi masih berada di dalam mode preview iframe. Buka URL aplikasi langsung di <strong>Google Chrome Android</strong>.
                </div>
              )}

              {isIOS ? (
                <ol className="space-y-2.5 text-[#CBD5E1] list-decimal list-inside">
                  <li>
                    Buka halaman ini menggunakan browser <strong>Safari</strong> di iPhone/iPad Anda.
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span>1.</span>
                    <span>
                      Ketuk tombol <Share className="inline w-3.5 h-3.5 text-[#38BDF8] mx-0.5" />{' '}
                      <strong>Share</strong> di bar bawah Safari.
                    </span>
                  </li>
                  <li>
                    Pilih <strong>Add to Home Screen</strong> lalu ketuk <strong>Add</strong>.
                  </li>
                </ol>
              ) : (
                <ol className="space-y-2.5 text-[#CBD5E1]">
                  <li className="flex gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#D4AF37]/20 text-[#D4AF37] font-semibold flex items-center justify-center shrink-0">
                      1
                    </span>
                    <span>
                      Salin URL di bawah dan buka langsung lewat <strong>Google Chrome</strong> di HP Android Anda.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#D4AF37]/20 text-[#D4AF37] font-semibold flex items-center justify-center shrink-0">
                      2
                    </span>
                    <span>
                      Ketuk ikon menu titik tiga (<strong>⋮</strong>) di pojok kanan atas Chrome (atau tekan tombol <strong>Install App</strong> jika muncul).
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#D4AF37]/20 text-[#D4AF37] font-semibold flex items-center justify-center shrink-0">
                      3
                    </span>
                    <span>
                      Pilih <strong>Tambahkan ke layar utama / Install aplikasi</strong>. Ikon <strong>AurumEA</strong> akan terpasang layaknya aplikasi Android native.
                    </span>
                  </li>
                </ol>
              )}

              {appUrl && (
                <div className="space-y-1.5 pt-1">
                  <span className="text-[11px] font-medium text-[#94A3B8]">
                    URL Aplikasi Anda:
                  </span>
                  <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-[#0B0E14] px-3 py-2">
                    <span className="flex-1 font-mono text-[11px] text-[#E6EDF3] truncate">
                      {appUrl}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyUrl()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#1E293B] hover:bg-[#334155] text-[#F8FAFC] text-[11px] font-medium shrink-0 transition-colors"
                    >
                      {copiedUrl ? (
                        <>
                          <Check className="w-3 h-3 text-[#10B981]" />
                          <span>Tersalin</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Salin</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              <p className="text-[11px] text-[#94A3B8] border-t border-white/[0.08] pt-3">
                Catatan MT5: Anda dapat memantau chart M5, menjalankan <strong>AI Hakim Keputusan</strong>, dan mengirim order dari Android, sementara terminal <strong>MetaTrader 5 + AurumEA.mq5</strong> tetap berjalan di PC/VPS Windows Anda.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
