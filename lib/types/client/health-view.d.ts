/** Graphical backlog-health dashboard, rendered from one bounded Host aggregate. */
import type { IdeasClient } from './ideas-client.ts';
import { type IdeasStatsRange } from '../core/ideas-stats.ts';
export interface HealthViewProps {
    client: IdeasClient;
    /** `''` = all, NO_WORKSPACE_FILTER = workspace-less, or a real id. */
    scopeWorkspaceId: string;
    workspaceTitle: (workspaceId: string) => string;
    boardRevision: number | undefined;
    range: IdeasStatsRange;
    tag?: string;
    knownTags: readonly string[];
    onRangeChange: (range: IdeasStatsRange) => void;
    onTagChange: (tag: string | undefined) => void;
    onOpenIdea: (ideaId: string) => void;
    onOpenIdeas: () => void;
    onWorkspace: (workspaceId: string | undefined) => void;
    onTag: (name: string) => void;
    onTriage: () => void;
}
export declare function HealthView({ client, scopeWorkspaceId, workspaceTitle, boardRevision, range, tag, knownTags, onRangeChange, onTagChange, onOpenIdea, onOpenIdeas, onWorkspace, onTag, onTriage }: HealthViewProps): import("react").JSX.Element;
