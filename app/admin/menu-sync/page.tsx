"use client";

import { useMemo, useState } from "react";

type PosProvider = "square" | "clover";
type SyncMode = "preview" | "preview-ai" | "publish-ai";

type SyncResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  locationID?: string;
  mode?: SyncMode;
  itemCount?: number;
  storagePath?: string;
  backupPath?: string;
  downloadUrl?: string;
  items?: any[];
};

const FUNCTION_URLS: Record<PosProvider, string> = {
  square:
    "https://us-central1-privitipizza41.cloudfunctions.net/syncSquareMenuTokens",
  clover:
    "https://us-central1-privitipizza41.cloudfunctions.net/syncCloverMenuTokens",
};

export default function MenuSyncAdminPage() {
  const [locationID, setLocationID] = useState("");
  const [posProvider, setPosProvider] = useState<PosProvider>("square");
  const [loadingMode, setLoadingMode] = useState<SyncMode | "">("");
  const [previewResult, setPreviewResult] = useState<SyncResponse | null>(null);
  const [aiPreviewResult, setAiPreviewResult] = useState<SyncResponse | null>(
    null
  );
  const [publishResult, setPublishResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState("");

  const cleanLocationID = useMemo(
    () => locationID.trim().toUpperCase(),
    [locationID]
  );

  const canRunPreview = cleanLocationID.length > 0 && !loadingMode;
  const canRunAiPreview =
    cleanLocationID.length > 0 && Boolean(previewResult?.success) && !loadingMode;
  const canPublish =
    cleanLocationID.length > 0 &&
    Boolean(aiPreviewResult?.success) &&
    !loadingMode;

  async function runSync(mode: SyncMode) {
    setError("");
    setLoadingMode(mode);

    if (mode === "preview") {
      setPreviewResult(null);
      setAiPreviewResult(null);
      setPublishResult(null);
    }

    if (mode === "preview-ai") {
      setAiPreviewResult(null);
      setPublishResult(null);
    }

    if (mode === "publish-ai") {
      setPublishResult(null);
    }

    try {
      if (!cleanLocationID) {
        throw new Error("Enter a location ID first.");
      }

      const response = await fetch(FUNCTION_URLS[posProvider], {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locationID: cleanLocationID,
          mode,
          includeItems: mode !== "publish-ai",
        }),
      });

      const data: SyncResponse = await response.json().catch(() => ({}));

      if (!response.ok || data.success === false) {
        throw new Error(data.error || `Request failed with ${response.status}`);
      }

      if (mode === "preview") {
        setPreviewResult(data);
      } else if (mode === "preview-ai") {
        setAiPreviewResult(data);
      } else {
        setPublishResult(data);
      }
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setLoadingMode("");
    }
  }

  function downloadJson(filename: string, data: unknown) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    anchor.click();

    URL.revokeObjectURL(url);
  }

  function ResultCard({
    title,
    result,
    showItems,
  }: {
    title: string;
    result: SyncResponse | null;
    showItems?: boolean;
  }) {
    if (!result) {
      return null;
    }

    return (
      <div style={styles.resultCard}>
        <h2 style={styles.resultTitle}>{title}</h2>

        <div style={styles.metaGrid}>
          <Meta label="Status" value={result.success ? "Success" : "Failed"} />
          <Meta label="Message" value={result.message || ""} />
          <Meta label="Location ID" value={result.locationID || ""} />
          <Meta label="Mode" value={result.mode || ""} />
          <Meta label="Item Count" value={String(result.itemCount ?? "")} />
          <Meta label="Storage Path" value={result.storagePath || ""} />
          <Meta label="Backup Path" value={result.backupPath || ""} />
        </div>

        {result.downloadUrl && (
          <div style={styles.buttonRow}>
            <a
              href={result.downloadUrl}
              target="_blank"
              rel="noreferrer"
              style={styles.linkButton}
            >
              Open / Download JSON
            </a>

            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => navigator.clipboard.writeText(result.downloadUrl || "")}
            >
              Copy Download URL
            </button>
          </div>
        )}

        {showItems && Array.isArray(result.items) && result.items.length > 0 && (
          <>
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() =>
                  downloadJson(
                    `${cleanLocationID}_${posProvider}_${result.mode}.json`,
                    result.items
                  )
                }
              >
                Download Items Only
              </button>

              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() =>
                  downloadJson(
                    `${cleanLocationID}_${posProvider}_${result.mode}_full_response.json`,
                    result
                  )
                }
              >
                Download Full Response
              </button>
            </div>

            <div style={styles.previewBox}>
              <pre style={styles.pre}>
                {JSON.stringify(result.items.slice(0, 12), null, 2)}
              </pre>
              {result.items.length > 12 && (
                <p style={styles.previewNote}>
                  Showing first 12 items of {result.items.length}. Use download
                  to review the full file.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <p style={styles.eyebrow}>HeySue Admin</p>
        <h1 style={styles.title}>Menu Sync</h1>
        <p style={styles.subtitle}>
          Generate POS menu previews, review AI aliases, and publish live
          menutokens.json files.
        </p>
      </div>

      <section style={styles.panel}>
        <div style={styles.formGrid}>
          <label style={styles.label}>
            Location ID
            <input
              value={locationID}
              onChange={(event) => setLocationID(event.target.value)}
              placeholder="Example: MEGCHK"
              style={styles.input}
            />
          </label>

          <label style={styles.label}>
            POS Provider
            <select
              value={posProvider}
              onChange={(event) =>
                setPosProvider(event.target.value as PosProvider)
              }
              style={styles.input}
            >
              <option value="square">Square</option>
              <option value="clover">Clover</option>
            </select>
          </label>
        </div>

        <div style={styles.flow}>
          <button
            type="button"
            disabled={!canRunPreview}
            style={{
              ...styles.primaryButton,
              opacity: canRunPreview ? 1 : 0.5,
            }}
            onClick={() => runSync("preview")}
          >
            {loadingMode === "preview" ? "Generating..." : "1. Generate Preview"}
          </button>

          <button
            type="button"
            disabled={!canRunAiPreview}
            style={{
              ...styles.primaryButton,
              opacity: canRunAiPreview ? 1 : 0.5,
            }}
            onClick={() => runSync("preview-ai")}
          >
            {loadingMode === "preview-ai"
              ? "Generating AI Aliases..."
              : "2. Generate AI Aliases"}
          </button>

          <button
            type="button"
            disabled={!canPublish}
            style={{
              ...styles.dangerButton,
              opacity: canPublish ? 1 : 0.5,
            }}
            onClick={() => {
              const confirmed = window.confirm(
                `Publish live menutokens.json for ${cleanLocationID}? This will back up and overwrite the live menu.`
              );

              if (confirmed) {
                runSync("publish-ai");
              }
            }}
          >
            {loadingMode === "publish-ai"
              ? "Publishing..."
              : "3. Publish Live Menu"}
          </button>
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}
      </section>

      <ResultCard title="Preview Result" result={previewResult} showItems />
      <ResultCard title="AI Alias Preview Result" result={aiPreviewResult} showItems />
      <ResultCard title="Publish Result" result={publishResult} />
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  if (!value) {
    return null;
  }

  return (
    <div>
      <div style={styles.metaLabel}>{label}</div>
      <div style={styles.metaValue}>{value}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    padding: "32px",
    background: "#f6f7fb",
    color: "#111827",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  },
  header: {
    maxWidth: "1100px",
    margin: "0 auto 24px auto",
  },
  eyebrow: {
    margin: 0,
    color: "#6b7280",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontSize: "12px",
  },
  title: {
    margin: "8px 0",
    fontSize: "40px",
    lineHeight: 1.1,
  },
  subtitle: {
    margin: 0,
    color: "#4b5563",
    fontSize: "16px",
  },
  panel: {
    maxWidth: "1100px",
    margin: "0 auto 20px auto",
    padding: "24px",
    borderRadius: "16px",
    background: "#ffffff",
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "16px",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    fontWeight: 700,
    fontSize: "14px",
  },
  input: {
    padding: "12px 14px",
    border: "1px solid #d1d5db",
    borderRadius: "10px",
    fontSize: "16px",
  },
  flow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "12px",
    marginTop: "20px",
  },
  primaryButton: {
    border: "none",
    borderRadius: "10px",
    background: "#2563eb",
    color: "#ffffff",
    padding: "12px 16px",
    fontWeight: 800,
    cursor: "pointer",
  },
  dangerButton: {
    border: "none",
    borderRadius: "10px",
    background: "#dc2626",
    color: "#ffffff",
    padding: "12px 16px",
    fontWeight: 800,
    cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid #d1d5db",
    borderRadius: "10px",
    background: "#ffffff",
    color: "#111827",
    padding: "10px 14px",
    fontWeight: 700,
    cursor: "pointer",
  },
  linkButton: {
    display: "inline-block",
    textDecoration: "none",
    borderRadius: "10px",
    background: "#111827",
    color: "#ffffff",
    padding: "10px 14px",
    fontWeight: 700,
  },
  buttonRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    marginTop: "16px",
  },
  errorBox: {
    marginTop: "16px",
    padding: "12px 14px",
    borderRadius: "10px",
    background: "#fee2e2",
    color: "#991b1b",
    fontWeight: 700,
  },
  resultCard: {
    maxWidth: "1100px",
    margin: "0 auto 20px auto",
    padding: "24px",
    borderRadius: "16px",
    background: "#ffffff",
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
  },
  resultTitle: {
    marginTop: 0,
    marginBottom: "16px",
    fontSize: "24px",
  },
  metaGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "14px",
  },
  metaLabel: {
    color: "#6b7280",
    fontSize: "12px",
    textTransform: "uppercase",
    fontWeight: 800,
    marginBottom: "4px",
  },
  metaValue: {
    wordBreak: "break-word",
    fontSize: "14px",
  },
  previewBox: {
    marginTop: "16px",
    borderRadius: "12px",
    background: "#0f172a",
    color: "#e5e7eb",
    overflow: "auto",
  },
  pre: {
    margin: 0,
    padding: "16px",
    fontSize: "12px",
    lineHeight: 1.5,
  },
  previewNote: {
    margin: 0,
    padding: "0 16px 16px 16px",
    color: "#cbd5e1",
    fontSize: "13px",
  },
};