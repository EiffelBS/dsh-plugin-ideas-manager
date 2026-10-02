/**
 * Find similar (the user-facing near-duplicate action).
 *
 * The split this file encodes is the whole point of the feature. The HOST owns
 * the cheap part — a normalized-title + tag-overlap scan over the open backlog
 * of one workspace, served on the opt-in `similar` read query and never on the
 * board's 2.5 s poll. The JUDGEMENT belongs to the ideas-analyst skill, which
 * reads the candidates' real bodies and reports. And the MERGE is the human's
 * own verb: this action can never perform one, so the most it can do is hand
 * the analyst a bounded, scored candidate set and let it recommend a pair.
 *
 * Both functions are PURE and synchronous, so the whole visibility matrix
 * (status x launcher x workspace-known) and the prompt's candidate rendering
 * are unit-testable without a DOM — the same discipline as `launch.ts`.
 */
import type { IdeaSimilarReport, IdeaStatus, IdeaTag } from '../core/ideas.ts';
import type { FindSimilarInput, ModelChoice } from './session-queue.ts';
/** The fields the gate and the launch input read; a list row or record fits. */
export interface SimilarTarget {
    id: string;
    status: IdeaStatus;
    /**
     * Required, and required to be KNOWN TO THE APP: a ledger-only workspace
     * cannot host a session, so there is nowhere to send the judgement.
     */
    workspaceId?: string;
    ideaNumber?: number;
    title: string;
    summary?: string;
    tags?: readonly IdeaTag[];
}
/** What the affordance gate needs to know about the board around one idea. */
export interface SimilarGate {
    /** A session launcher resolved; without one no analyst can be started. */
    hasLauncher: boolean;
    /**
     * Workspace ids the DSH app actually knows (a key of the workspace
     * registry). Exactly the same gate the AI capture and the Re-analyze
     * affordance use — a finding that cannot be read back by a session is not
     * worth offering.
     */
    knownWorkspaceIds: ReadonlySet<string>;
}
/**
 * Whether the Find-similar affordance belongs on this card.
 *
 * Same gate as Re-analyze, and deliberately so: both are "hand a bounded
 * question to an analyst session in this idea's workspace", so they must
 * appear and disappear together. An OPEN idea only — the scan compares the
 * idea against an OPEN backlog, and a closed idea has a state that already
 * answers the question a human would ask it.
 */
export declare function canFindSimilar(idea: SimilarTarget, gate: SimilarGate): boolean;
/**
 * Default number of candidates the modal shows and the prompt carries. Bounded
 * on purpose: the analyst weighs a shortlist and says what it weighed. A long
 * list would turn "is this a duplicate?" into a backlog review, and the Host
 * caps the hard maximum at IDEAS_SIMILAR_MAX_CANDIDATES anyway.
 */
export declare const FIND_SIMILAR_CANDIDATE_LIMIT = 8;
/**
 * Build the analyst launch input from the idea and the report the Host just
 * served. Pure mapping, no fetch and no merge: the `model` the modal picked
 * rides along exactly like it does for the capture and the re-analysis.
 */
export declare function buildFindSimilarInput(idea: SimilarTarget, report: IdeaSimilarReport, context: {
    workspaceTitle: string;
    model?: ModelChoice;
}): FindSimilarInput | undefined;
/**
 * One candidate row for the modal, with the signal names resolved to words.
 * Kept separate from the launch input so the UI and the prompt never disagree
 * about what a candidate is.
 */
export interface SimilarCandidateView {
    id: string;
    ideaNumber?: number;
    title: string;
    score: number;
    /** Display label of each fired signal, already localized. */
    signals: string[];
}
export declare function similarCandidateViews(report: IdeaSimilarReport, labels: {
    title: string;
    tags: string;
}): SimilarCandidateView[];
