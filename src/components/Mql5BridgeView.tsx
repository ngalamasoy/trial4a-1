import React, { useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Loader2,
  Play,
  ShieldCheck,
  Unplug,
  AlertCircle,
} from 'lucide-react';
import {
  buildBridgeFiles,
  type BridgeFileAsset,
  type Mt5ExecutionMode,
} from '../utils/mt5Templates.ts';
import {
  AI_PROVIDER_OPTIONS,
  type EaConfig,
  type Mt5BridgeStatus,
} from '../types/trading.ts';

interface Mql5BridgeViewProps {
  mt5Status: Mt5BridgeStatus;
  config: EaConfig;
  onRefreshStatus: () => Promise<void>;
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const Mql5BridgeView: React.FC<Mql5BridgeViewProps> = ({
  mt5Status,
  config,
  onRefreshStatus,
}) => {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://your-app-url.run.app';
  const [executionMode, setExecutionMode] = useState<Mt5ExecutionMode>('COPY_WEB_ONLY');

  const files = useMemo(
    () =>
      buildBridgeFiles(
        origin,
        mt5Status.profile?.bridgeKey || '',
        config,
        executionMode
      ),
    [origin, mt5Status.profile?.bridgeKey, config, executionMode]
  );

  const selectedAiLabel = useMemo(
    () =>
      AI_PROVIDER_OPTIONS.find((o) => o.id === (config.aiProvider ?? 'AUTO'))?.shortLabel ||
      config.aiProvider ||
      'AUTO',
    [config.aiProvider]
  );

  // MT5 Account Login / Password / Server Form State
  const [loginInput, setLoginInput] = useState(mt5Status.profile?.login || '');
  const [passwordInput, setPasswordInput] = useState('');
  const [serverInput, setServerInput] = useState(mt5Status.profile?.server || '');
  const [accountType, setAccountType] = useState<'REAL' | 'DEMO'>(
    mt5Status.profile?.accountType || 'REAL'
  );
  const [submittingAccount, setSubmittingAccount] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const [selectedId, setSelectedId] = useState<BridgeFileAsset['id']>('mq5');
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    mt5Line?: string;
    error?: string;
    latencyMs?: number;
  } | null>(null);

  const activeFile = files.find((f) => f.id === selectedId) || files[0];

  const handleConnectAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingAccount(true);
    setAccountError(null);
    try {
      const res = await fetch('/api/mt5/account/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: loginInput,
          password: passwordInput,
          server: serverInput,
          accountType,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Gagal mendaftarkan akun MT5.');
      }
      setPasswordInput('');
      await onRefreshStatus();
    } catch (err: unknown) {
      setAccountError(err instanceof Error ? err.message : 'Gagal menghubungkan akun MT5.');
    } finally {
      setSubmittingAccount(false);
    }
  };

  const handleDisconnectAccount = async () => {
    setSubmittingAccount(true);
    try {
      await fetch('/api/mt5/account/disconnect', { method: 'POST' });
      setLoginInput('');
      setServerInput('');
      setPasswordInput('');
      await onRefreshStatus();
    } finally {
      setSubmittingAccount(false);
    }
  };

  const handleCopyBridgeKey = async () => {
    if (!mt5Status.profile?.bridgeKey) return;
    try {
      await navigator.clipboard.writeText(mt5Status.profile.bridgeKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleDownloadAll = () => {
    files.forEach((file, idx) => {
      setTimeout(() => {
        downloadTextFile(file.filename, file.content);
      }, idx * 180);
    });
  };

  const handleTestEndpoint = async () => {
    setTesting(true);
    setTestResult(null);
    const t0 = Date.now();
    try {
      const res = await fetch('/api/ea/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategyFocus: config.strategyFocus,
          fullAiControl: config.fullAiControl ?? true,
          noSlAiExit: config.noSlAiExit ?? true,
          aiProvider: config.aiProvider ?? 'AUTO',
          aiThinkingHigh: config.aiThinkingHigh ?? true,
          riskPercent: config.riskPercent,
          accountBalance: mt5Status.liveAccount?.balance || 10000,
          openPositionsCount: mt5Status.liveAccount?.positions.length || 0,
        }),
      });
      const data = (await res.json()) as { mt5Line?: string; error?: string };
      if (!res.ok || !data.mt5Line) {
        throw new Error(data.error || 'Respon endpoint tidak valid.');
      }
      setTestResult({
        ok: true,
        mt5Line: data.mt5Line,
        latencyMs: Date.now() - t0,
      });
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Gagal menghubungi endpoint.',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
        <div>
          <h1 className="text-xl font-semibold text-[#F8FAFC]">
            Akun Broker MT5 (Real / Demo) &amp; Bridge DLL
          </h1>
          <p className="text-xs text-[#94A3B8] mt-1">
            Masukkan Login, Password, dan Server MT5 Anda lalu jalankan EA Bridge di MetaTrader 5 untuk eksekusi real-time langsung dari web ini.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleTestEndpoint}
            disabled={testing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-white/[0.12] bg-[#111620] text-[#E6EDF3] hover:bg-[#161C28] disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            {testing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 text-[#D4AF37]" />
            )}
            <span>Uji Respon MT5</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadAll}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-[#D4AF37] text-[#0B0E14] hover:bg-[#E5B842] transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Unduh Semua (5 File)</span>
          </button>
        </div>
      </div>

      {/* Account Connection Card + Live Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-[#111620] border border-white/[0.08] rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
            <h2 className="text-sm font-semibold text-[#F8FAFC]">
              Kredensial Akun Trading MT5
            </h2>
            {mt5Status.configured && (
              <button
                type="button"
                onClick={handleDisconnectAccount}
                disabled={submittingAccount}
                className="inline-flex items-center gap-1 text-xs text-[#EF4444] hover:underline"
              >
                <Unplug className="w-3.5 h-3.5" />
                <span>Putuskan Akun</span>
              </button>
            )}
          </div>

          <form onSubmit={handleConnectAccount} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAccountType('REAL')}
                className={`py-2 px-3 rounded-md border font-medium transition-colors ${
                  accountType === 'REAL'
                    ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-[#F8FAFC]'
                    : 'bg-[#0B0E14] border-white/[0.08] text-[#94A3B8]'
                }`}
              >
                Akun Real (Live)
              </button>
              <button
                type="button"
                onClick={() => setAccountType('DEMO')}
                className={`py-2 px-3 rounded-md border font-medium transition-colors ${
                  accountType === 'DEMO'
                    ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-[#F8FAFC]'
                    : 'bg-[#0B0E14] border-white/[0.08] text-[#94A3B8]'
                }`}
              >
                Akun Demo Broker
              </button>
            </div>

            <div className="space-y-1">
              <label className="block font-medium text-[#E6EDF3]">
                Nomor Login MT5
              </label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="Contoh: 184920341"
                value={loginInput}
                onChange={(e) => setLoginInput(e.target.value)}
                className="w-full px-3 py-2 font-mono rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] placeholder:text-[#64748B] focus:outline-none focus:border-[#D4AF37]"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="block font-medium text-[#E6EDF3]">
                Password Trading MT5
              </label>
              <input
                type="password"
                placeholder="Password akun MT5 Anda"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                className="w-full px-3 py-2 font-mono rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] placeholder:text-[#64748B] focus:outline-none focus:border-[#D4AF37]"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="block font-medium text-[#E6EDF3]">
                Server Broker MT5
              </label>
              <input
                type="text"
                placeholder="Contoh: Exness-MT5Real12 / ICMarketsSC-MT5 / XMGlobal-MT5"
                value={serverInput}
                onChange={(e) => setServerInput(e.target.value)}
                className="w-full px-3 py-2 font-mono rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] placeholder:text-[#64748B] focus:outline-none focus:border-[#D4AF37]"
                required
              />
            </div>

            {accountError && (
              <div className="p-2.5 rounded bg-[#EF4444]/10 border border-[#EF4444]/30 text-[#FCA5A5] flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-[#EF4444] shrink-0 mt-0.5" />
                <span>{accountError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submittingAccount}
              className="w-full py-2.5 px-4 text-xs font-semibold rounded-md bg-[#D4AF37] text-[#0B0E14] hover:bg-[#E5B842] disabled:opacity-60 transition-colors"
            >
              {submittingAccount
                ? 'Menyimpan Kredensial Bridge...'
                : 'Daftarkan Akun & Buat Bridge Key'}
            </button>

            <p className="text-[11px] text-[#94A3B8] leading-relaxed">
              Password hanya dipakai untuk menghasilkan <em>Bridge Key</em> terenkripsi (HMAC-SHA256) dan tidak pernah disimpan dalam bentuk teks terbuka. Login broker tetap diautentikasi secara aman di terminal MetaTrader 5 Anda.
            </p>
          </form>
        </section>

        {/* Live Bridge Telemetry & Verification */}
        <section className="bg-[#111620] border border-white/[0.08] rounded-lg p-5 space-y-4 text-xs">
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
            <h2 className="text-sm font-semibold text-[#F8FAFC]">
              Status Koneksi Real Trade MT5
            </h2>
            <span
              className={`font-semibold ${
                mt5Status.connected
                  ? 'text-[#10B981]'
                  : mt5Status.configured
                  ? 'text-[#F59E0B]'
                  : 'text-[#94A3B8]'
              }`}
            >
              {mt5Status.connected
                ? 'Terhubung Real-Time'
                : mt5Status.configured
                ? 'Menunggu EA MT5'
                : 'Belum Terkonfigurasi'}
            </span>
          </div>

          {!mt5Status.configured ? (
            <div className="py-8 text-center space-y-2 text-[#94A3B8]">
              <p className="text-[#E6EDF3] font-medium">
                Mode Saat Ini: Simulasi Demo Web
              </p>
              <p className="max-w-sm mx-auto leading-relaxed">
                Daftarkan Login, Password, dan Server MT5 di sebelah kiri, lalu pasang file{' '}
                <code className="text-[#D4AF37] font-mono">AurumEA_XAUUSD_M5.mq5</code> ke MetaTrader 5 Anda agar order dari web ini langsung dieksekusi di akun broker asli.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 rounded-md bg-[#0B0E14] border border-white/[0.08] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[#94A3B8]">Akun Terdaftar</span>
                  <span className="font-mono text-[#F8FAFC] font-semibold">
                    {mt5Status.profile?.login} · {mt5Status.profile?.server} ({mt5Status.profile?.accountType})
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#94A3B8] shrink-0">Bridge Key</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <code className="font-mono text-[#D4AF37] truncate">
                      {mt5Status.profile?.bridgeKey}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyBridgeKey}
                      className="text-[#94A3B8] hover:text-[#F8FAFC] shrink-0"
                      title="Salin Bridge Key"
                    >
                      {copiedKey ? (
                        <Check className="w-3.5 h-3.5 text-[#10B981]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {mt5Status.connected && mt5Status.liveAccount ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-[#10B981] font-medium">
                    <ShieldCheck className="w-4 h-4" />
                    <span>
                      Sinkronisasi aktif dengan {mt5Status.liveAccount.company}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-px bg-white/[0.08] border border-white/[0.08] rounded-md overflow-hidden font-mono tabular-nums">
                    <div className="bg-[#0B0E14] p-2.5">
                      <div className="text-[#94A3B8] text-[11px]">Balance Asli</div>
                      <div className="text-[#F8FAFC] font-semibold mt-0.5">
                        {mt5Status.liveAccount.currency}{' '}
                        {mt5Status.liveAccount.balance.toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-[#0B0E14] p-2.5">
                      <div className="text-[#94A3B8] text-[11px]">Equity Asli</div>
                      <div className="text-[#F8FAFC] font-semibold mt-0.5">
                        {mt5Status.liveAccount.currency}{' '}
                        {mt5Status.liveAccount.equity.toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-[#0B0E14] p-2.5">
                      <div className="text-[#94A3B8] text-[11px]">Free Margin</div>
                      <div className="text-[#E6EDF3] mt-0.5">
                        {mt5Status.liveAccount.freeMargin.toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-[#0B0E14] p-2.5">
                      <div className="text-[#94A3B8] text-[11px]">Leverage / Posisi</div>
                      <div className="text-[#E6EDF3] mt-0.5">
                        1:{mt5Status.liveAccount.leverage} ·{' '}
                        {mt5Status.liveAccount.positions.length} aktif
                      </div>
                    </div>
                  </div>
                  {mt5Status.connectedTerminals && mt5Status.connectedTerminals.length > 0 && (
                    <div className="p-2.5 rounded-md bg-[#0B0E14] border border-white/[0.08] space-y-1.5">
                      <div className="text-[11px] font-medium text-[#94A3B8]">
                        Terminal MT5 Penerima Copy Order ({mt5Status.connectedTerminals.length} aktif)
                      </div>
                      <div className="space-y-1">
                        {mt5Status.connectedTerminals.map((t) => (
                          <div
                            key={t.terminalId}
                            className="flex items-center justify-between text-[11px] font-mono"
                          >
                            <span className="text-[#E6EDF3]">
                              #{t.login} · {t.server}{' '}
                              <span className="text-[#D4AF37]">
                                {t.isPrimary ? '(Utama)' : '(Copy Follower)'}
                              </span>
                            </span>
                            <span className="text-[#94A3B8]">
                              {t.currency} {t.balance.toFixed(2)} · {t.positionsCount} pos
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3.5 rounded-md bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[#FDE68A] space-y-2 leading-relaxed">
                  <p className="font-semibold">
                    Langkah Terakhir agar Real Trade Berjalan:
                  </p>
                  <p>
                    1. Unduh file <code className="font-mono text-[#F8FAFC]">AurumEA_XAUUSD_M5.mq5</code> di bawah (Bridge Key Anda sudah terisi otomatis di dalamnya).
                    <br />
                    2. Buka terminal MetaTrader 5 di PC/VPS Anda dan login menggunakan akun{' '}
                    <strong className="text-[#F8FAFC]">{mt5Status.profile?.login}</strong> pada server{' '}
                    <strong className="text-[#F8FAFC]">{mt5Status.profile?.server}</strong>.
                    <br />
                    3. Pasang EA ke chart <strong className="text-[#F8FAFC]">XAUUSD M5</strong> dan aktifkan{' '}
                    <em>Algo Trading</em>. Status di halaman ini akan otomatis berubah menjadi{' '}
                    <strong className="text-[#10B981]">Terhubung Real-Time</strong>.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Live MT5 Endpoint Test Output */}
      {testResult && (
        <section
          className={`p-4 rounded-lg border text-xs space-y-2 ${
            testResult.ok
              ? 'bg-[#10B981]/10 border-[#10B981]/30 text-[#E6EDF3]'
              : 'bg-[#EF4444]/10 border-[#EF4444]/30 text-[#FCA5A5]'
          }`}
        >
          <div className="flex items-center justify-between font-medium">
            <span>
              {testResult.ok
                ? 'Output mt5Line yang diterima DLL & MT5'
                : 'Gagal Menguji Endpoint'}
            </span>
            {testResult.latencyMs !== undefined && (
              <span className="font-mono tabular-nums text-[#94A3B8]">
                {testResult.latencyMs} ms
              </span>
            )}
          </div>
          {testResult.mt5Line ? (
            <pre className="p-2.5 rounded bg-[#0B0E14] border border-white/[0.08] font-mono text-[11px] text-[#10B981] overflow-x-auto whitespace-pre-wrap break-all">
              {testResult.mt5Line}
            </pre>
          ) : (
            <p>{testResult.error}</p>
          )}
        </section>
      )}

      {/* Setup Guide: DLL vs WebRequest */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <section className="bg-[#111620] border border-white/[0.08] rounded-lg p-5 space-y-2.5">
          <h2 className="text-sm font-semibold text-[#F8FAFC]">
            Opsi 1: Compile &amp; Pasang DLL Windows x64
          </h2>
          <ol className="space-y-1.5 text-[#94A3B8] list-decimal list-inside leading-relaxed">
            <li>
              Unduh <code className="text-[#E6EDF3] font-mono">AurumGeminiBridge.cpp</code>,{' '}
              <code className="text-[#E6EDF3] font-mono">.h</code>,{' '}
              <code className="text-[#E6EDF3] font-mono">.def</code>, dan{' '}
              <code className="text-[#E6EDF3] font-mono">build_dll.bat</code> ke satu folder di Windows.
            </li>
            <li>
              Jalankan <code className="text-[#D4AF37] font-mono">build_dll.bat</code> melalui{' '}
              <em>x64 Native Tools Command Prompt for VS</em> atau MinGW-w64 untuk menghasilkan{' '}
              <code className="text-[#E6EDF3] font-mono">AurumGeminiBridge.dll</code>.
            </li>
            <li>
              Salin <code className="text-[#E6EDF3] font-mono">AurumGeminiBridge.dll</code> ke{' '}
              <code className="text-[#E6EDF3] font-mono">MQL5\Libraries\</code>, lalu centang{' '}
              <strong className="text-[#E6EDF3]">Allow DLL imports</strong> saat attach EA ke chart XAUUSD M5.
            </li>
          </ol>
        </section>

        <section className="bg-[#111620] border border-white/[0.08] rounded-lg p-5 space-y-2.5">
          <h2 className="text-sm font-semibold text-[#F8FAFC]">
            Opsi 2: Tanpa DLL (Native WebRequest MT5)
          </h2>
          <ol className="space-y-1.5 text-[#94A3B8] list-decimal list-inside leading-relaxed">
            <li>
              Salin <code className="text-[#E6EDF3] font-mono">AurumEA_XAUUSD_M5.mq5</code> ke{' '}
              <code className="text-[#E6EDF3] font-mono">MQL5\Experts\</code> dan compile di MetaEditor (F7).
            </li>
            <li>
              Di MetaTrader 5, buka <strong className="text-[#E6EDF3]">Tools &rarr; Options &rarr; Expert Advisors</strong>, aktifkan{' '}
              <strong className="text-[#E6EDF3]">Allow WebRequest for listed URL</strong> dan tambahkan{' '}
              <code className="text-[#D4AF37] font-mono break-all">{origin}</code>.
            </li>
            <li>
              Saat memasang EA ke chart XAUUSD M5, ubah input{' '}
              <code className="text-[#E6EDF3] font-mono">InpUseDll = false</code>.
            </li>
          </ol>
        </section>
      </div>

      {/* Copy Trade Mode & Full Web Parameter Sync Summary */}
      <section className="bg-[#111620] border border-[#D4AF37]/30 rounded-lg p-5 space-y-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#F8FAFC]">
              Sinkronisasi Penuh Web → MQL5 &amp; Mode Copy Order
            </h2>
            <p className="text-[11px] text-[#94A3B8] mt-0.5">
              Seluruh pilihan Engine AI, Thinking HIGH, Strategi, dan Parameter Risiko dari Web sudah otomatis dimasukkan ke dalam input <code className="text-[#D4AF37] font-mono">AurumEA_XAUUSD_M5.mq5</code>. Pasang dengan <code className="text-[#D4AF37] font-mono">Bridge Key</code> yang sama di beberapa MT5 sekaligus untuk copy multi-akun.
            </p>
          </div>
          <select
            aria-label="Mode Eksekusi EA MQL5"
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as Mt5ExecutionMode)}
            className="px-3 py-2 text-xs rounded-md bg-[#0B0E14] border border-[#D4AF37]/50 text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
          >
            <option value="COPY_WEB_ONLY">
              Copy Order Web Saja (Mirror Lot, TP, SL &amp; Close dari Web)
            </option>
            <option value="HYBRID_AI_AND_WEB">
              Hybrid (Copy Web + Analisa AI Mandiri di MT5)
            </option>
            <option value="STANDALONE_AI">
              Standalone AI MT5 Saja (Pakai Engine AI di MT5)
            </option>
          </select>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 font-mono text-[11px]">
          <div className="p-2 rounded bg-[#0B0E14] border border-white/[0.06]">
            <span className="text-[#94A3B8] block">Engine AI</span>
            <span className="text-[#D4AF37] font-semibold truncate block">{selectedAiLabel}</span>
          </div>
          <div className="p-2 rounded bg-[#0B0E14] border border-white/[0.06]">
            <span className="text-[#94A3B8] block">Deep Learning / Think</span>
            <span className="text-[#E6EDF3] font-semibold">
              {(config.aiThinkingHigh ?? true) ? 'HIGH (Aktif)' : 'Standar'}
            </span>
          </div>
          <div className="p-2 rounded bg-[#0B0E14] border border-white/[0.06]">
            <span className="text-[#94A3B8] block">Strategi &amp; Exit</span>
            <span className="text-[#E6EDF3] font-semibold">
              {config.strategyFocus} · {(config.noSlAiExit ?? true) ? 'No-SL AI Exit' : 'SL Aktif'}
            </span>
          </div>
          <div className="p-2 rounded bg-[#0B0E14] border border-white/[0.06]">
            <span className="text-[#94A3B8] block">Lot &amp; Risk</span>
            <span className="text-[#E6EDF3] font-semibold">
              {config.lotMode === 'FIXED_LOT'
                ? `Fixed ${config.fixedLot.toFixed(2)}`
                : `Risk ${config.riskPercent}%`}
            </span>
          </div>
        </div>
      </section>

      {/* File Selector + Code Viewer */}
      <section className="bg-[#111620] border border-white/[0.08] rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 overflow-x-auto">
            {files.map((file) => {
              const isSelected = file.id === activeFile.id;
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => setSelectedId(file.id)}
                  className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    isSelected
                      ? 'bg-[#1E293B] text-[#F8FAFC] font-semibold'
                      : 'text-[#94A3B8] hover:text-[#E6EDF3]'
                  }`}
                >
                  {file.filename}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-white/[0.1] bg-[#0B0E14] text-[#E6EDF3] hover:bg-[#161C28] transition-colors whitespace-nowrap"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#10B981]" />
                  <span>Tersalin</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Salin</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => downloadTextFile(activeFile.filename, activeFile.content)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[#D4AF37]/40 bg-[#D4AF37]/10 text-[#D4AF37] hover:bg-[#D4AF37]/20 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Unduh {activeFile.filename}</span>
            </button>
          </div>
        </div>

        <div className="px-4 py-2 bg-[#0B0E14] border-b border-white/[0.06] flex items-center justify-between text-[11px] text-[#94A3B8]">
          <span>{activeFile.label}</span>
          <span className="font-mono">Lokasi MT5: {activeFile.targetFolder}</span>
        </div>

        <pre className="p-4 text-xs font-mono text-[#CBD5E1] bg-[#0B0E14] overflow-x-auto max-h-[480px] leading-relaxed">
          {activeFile.content}
        </pre>
      </section>
    </div>
  );
};
