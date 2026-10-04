/**
 * Backup surface of the settings section: timestamped snapshots of
 * the whole board, a restore that keeps what it replaces, and the portable
 * export/import that moves a ledger between machines.
 *
 * Three rules shape the panel, and all three are about being honest rather than
 * convenient:
 *
 *  - **A restore is loud before and after.** It asks first, spelling out that
 *    the current board is displaced but kept, and after the click it NAMES the
 *    snapshot holding the board that was replaced — "it was overwritten" and
 *    "you can go back to it" are different sentences.
 *  - **A refusal is a sentence, not a spinner.** The Host answers a refusal with
 *    its own reason (a run in flight, an unreadable file, a ledger written by
 *    another version) and the panel prints it verbatim. A restore that failed
 *    quietly is indistinguishable from one that worked.
 *  - **Nothing here depends on the settings service.** The panel drives its own
 *    routes, so a deployment whose settings surface is unavailable still gets
 *    snapshots and restore; only the display options above are degraded.
 *
 * The download is a plain link to the Host's content route, not a blob: the
 * bytes are the ledger's own, so the file the browser stores is exactly the
 * document a restore adopts on the other machine.
 */
import type { IdeasClient } from './ideas-client.ts';
import type { IdeasSnapshotInfo } from '../protocol.ts';
/** Props of the backup panel (the client it drives is the only dependency). */
export interface BackupPanelProps {
    client: IdeasClient;
}
/** Compact date + size line of one snapshot. */
export declare function backupItemMeta(snapshot: IdeasSnapshotInfo): string;
export declare function BackupPanel({ client }: BackupPanelProps): import("react").JSX.Element;
