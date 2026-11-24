/** Read-only synchronization preview, explicit mapping and conflict decisions. */
import type { IdeasClient } from './ideas-client.ts';
export interface SyncPanelProps {
    client: IdeasClient;
}
export declare function SyncPanel({ client }: SyncPanelProps): import("react").JSX.Element;
