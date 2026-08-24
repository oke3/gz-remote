/**
 * Windows environment probe: a PowerShell script template whose output is a set
 * of OCR_* key=value markers, plus a tolerant parser for that output.
 * Markers (not prose) survive noisy ssh banners, MOTDs and PS error spew.
 */

import type { ProbeResult } from "./types.ts";

/**
 * Render the probe script. Runs under `powershell -NoProfile -NonInteractive -EncodedCommand`.
 * Reports: PS version, execution policy, opencode path, git path, OS caption.
 */
export function renderProbeScript(): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$ocrPsv = ''",
    "$ocrEp  = ''",
    "$ocrOc  = ''",
    "$ocrGt  = ''",
    "$ocrOs  = ''",
    "try { $ocrPsv = $PSVersionTable.PSVersion.ToString() } catch {}",
    "try { $ocrEp  = Get-ExecutionPolicy } catch {}",
    "try { $ocrOc  = (Get-Command opencode -ErrorAction SilentlyContinue).Source } catch {}",
    "try { $ocrGt  = (Get-Command git.exe -ErrorAction SilentlyContinue).Source } catch {}",
    "try { $ocrOs  = (Get-CimInstance Win32_OperatingSystem).Caption } catch {}",
    'Write-Output ("OCR_PSVERSION=" + $ocrPsv)',
    'Write-Output ("OCR_EXECUTIONPOLICY=" + $ocrEp)',
    'Write-Output ("OCR_OPENCODE=" + $ocrOc)',
    'Write-Output ("OCR_GITPATH=" + $ocrGt)',
    'Write-Output ("OCR_OSCAPTION=" + $ocrOs)',
  ].join("\r\n");
}

function optional(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Parse OCR_* markers out of arbitrary stdout. Unknown lines are ignored.
 * `windows` is true only when OCR_PSVERSION was seen with a non-empty value.
 */
export function parseProbeOutput(stdout: string): ProbeResult {
  const map = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!key.startsWith("OCR_")) continue;
    // First marker wins; later duplicates (e.g. echoed commands) are ignored.
    if (!map.has(key.slice(4))) map.set(key.slice(4), line.slice(eq + 1));
  }
  const psVersion = optional(map.get("PSVERSION"));
  return {
    windows: psVersion !== null,
    psVersion,
    executionPolicy: optional(map.get("EXECUTIONPOLICY")),
    opencodePath: optional(map.get("OPENCODE")),
    gitPath: optional(map.get("GITPATH")),
    osCaption: optional(map.get("OSCAPTION")),
  };
}
