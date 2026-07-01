'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';

import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ExportFormat = 'zip' | 'tar.gz';

function friendlyExportError(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'openclaw_export_no_files':
      return 'No exportable OpenClaw workspace files were found.';
    case 'openclaw_export_too_large':
      return 'Your exported text is too large. Trim large notes and try again.';
    case 'openclaw_export_too_many_files':
      return 'Your workspace has too many files to export.';
    case 'openclaw_export_encryption_unsupported':
      return 'Encryption is only available for zip exports.';
    case 'instance_not_running':
      return 'Your KiloClaw instance must be running to export.';
    case 'controller_route_unavailable':
      return 'Export is not available yet on this instance. Try again after it updates.';
    default:
      return fallback || 'Failed to export workspace.';
  }
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function OpenclawExportCard({
  isRunning,
  instanceStatus,
  organizationId,
}: {
  isRunning: boolean;
  instanceStatus: KiloClawDashboardStatus['status'];
  organizationId: string | null;
}) {
  const posthog = usePostHog();
  const [format, setFormat] = useState<ExportFormat>('zip');
  const [password, setPassword] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const encryptionAvailable = format === 'zip';
  const usingPassword = encryptionAvailable && password.length > 0;

  function handleFormatChange(next: string) {
    const nextFormat = next as ExportFormat;
    setFormat(nextFormat);
    // Encryption is zip-only; clear any passphrase when leaving zip.
    if (nextFormat !== 'zip') {
      setPassword('');
    }
  }

  async function handleExport() {
    if (!isRunning || isExporting) return;

    setIsExporting(true);
    setExportError(null);
    posthog?.capture('claw_openclaw_export_started', {
      format,
      encrypted: usingPassword,
      instance_status: instanceStatus,
    });

    try {
      const response = await fetch('/api/claw/openclaw-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          ...(usingPassword ? { password } : {}),
          ...(organizationId ? { organizationId } : {}),
        }),
      });

      if (!response.ok) {
        let code: string | undefined;
        let message = '';
        try {
          const body = (await response.json()) as {
            error?: string;
            code?: string;
          };
          code = body.code;
          message = body.error ?? '';
        } catch {
          // non-JSON error body
        }
        const friendly = friendlyExportError(code, message);
        setExportError(friendly);
        toast.error(friendly);
        posthog?.capture('claw_openclaw_export_failed', {
          format,
          encrypted: usingPassword,
          error_code: code ?? 'unknown',
          status: response.status,
          instance_status: instanceStatus,
        });
        return;
      }

      const blob = await response.blob();
      triggerBlobDownload(blob, `openclaw-workspace-export.${format}`);

      posthog?.capture('claw_openclaw_export_completed', {
        format,
        encrypted: usingPassword,
        file_count: Number(response.headers.get('x-openclaw-export-file-count') ?? '0'),
        total_bytes: Number(response.headers.get('x-openclaw-export-total-bytes') ?? '0'),
        skipped: Number(response.headers.get('x-openclaw-export-skipped') ?? '0'),
        instance_status: instanceStatus,
      });
      toast.success('OpenClaw workspace exported.');
      setPassword('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to export workspace.';
      setExportError(message);
      toast.error(`Failed to export OpenClaw workspace: ${message}`);
      posthog?.capture('claw_openclaw_export_failed', {
        format,
        encrypted: usingPassword,
        error_code: 'network_error',
        instance_status: instanceStatus,
      });
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="mb-3 flex items-center gap-3">
        <Download className="text-muted-foreground h-5 w-5 shrink-0" />
        <div>
          <p className="text-sm font-medium">OpenClaw Export</p>
          <p className="text-muted-foreground text-xs">
            Download your workspace text — profile, instructions, and memory — to move it to another
            OpenClaw. Skill and canvas files aren't included, but you get a list of installed skills
            to reinstall. Does not include credentials, channels, sessions, config, or secrets.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="openclaw-export-format">Format</Label>
            <Select
              value={format}
              onValueChange={handleFormatChange}
              disabled={!isRunning || isExporting}
            >
              <SelectTrigger id="openclaw-export-format" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zip">.zip</SelectItem>
                <SelectItem value="tar.gz">.tar.gz</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="openclaw-export-password">Password (optional)</Label>
            <Input
              id="openclaw-export-password"
              type="password"
              autoComplete="new-password"
              placeholder={encryptionAvailable ? 'Encrypt the zip' : 'Switch to .zip to encrypt'}
              value={password}
              onChange={event => setPassword(event.currentTarget.value)}
              disabled={!isRunning || !encryptionAvailable || isExporting}
              aria-describedby="openclaw-export-password-help"
              maxLength={256}
            />
          </div>

          <Button
            type="button"
            size="sm"
            onClick={handleExport}
            disabled={!isRunning || isExporting}
            className="w-full sm:w-auto"
          >
            {isExporting ? 'Exporting…' : 'Export workspace'}
          </Button>
        </div>

        <p id="openclaw-export-password-help" className="text-muted-foreground text-xs">
          {encryptionAvailable
            ? "Encrypts the zip with AES-256. Keep it safe — we can't recover it. Opening may require 7-Zip (Windows) or Keka (macOS)."
            : 'Encryption is only available for .zip exports.'}
        </p>

        <p className="text-muted-foreground text-xs">
          Note: TOOLS.md includes KiloClaw-specific tool instructions that may not apply on another
          host.
        </p>
      </div>

      {exportError && (
        <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
          <p className="text-xs text-red-300">{exportError}</p>
        </div>
      )}

      {!isRunning && (
        <p className="mt-2 text-xs text-amber-400">
          Instance must be running before exporting your OpenClaw workspace.
        </p>
      )}
    </div>
  );
}
