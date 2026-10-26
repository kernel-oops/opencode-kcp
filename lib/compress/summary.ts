import { createHash } from "node:crypto"

export function summaryHash(summary: string): string {
    // JSON escapes lone UTF-16 surrogates, unlike lossy direct UTF-8 encoding.
    return createHash("sha256").update(JSON.stringify(summary), "utf8").digest("hex")
}

/** This replaces a completed argument only in the outgoing model view. */
export const COMPRESS_INPUT_ARCHIVE_MARKER =
    "[DCP outgoing-view replacement after completion: not the original submitted argument; original argument retained in actual history. Not summary content.]"

/** Known archive metadata alone cannot replace a real summary. Quotations in prose can. */
export function validateSummaryContent(summary: string, prefix: string): void {
    const value = summary.trim().replace(/\s+/g, " ")
    if (
        value === COMPRESS_INPUT_ARCHIVE_MARKER ||
        /^\[DCP: original submitted summary remains in stored history; represented by active compression [1-9]\d*\.(?: NOT summary content\.)?\]$/.test(
            value,
        )
    ) {
        throw new Error(
            `${prefix}.summary is DCP archive metadata, NOT summary content. Use the actual rendered summary/source, or stop; never resubmit the archive marker as a replacement.`,
        )
    }
}
