/**
 * The SHARED execution prompt of an idea (idea #66).
 *
 * One function, one prompt, two execution backends: the mirrored TaskBoard
 * card (the runner sends `task.prompt !== '' ? task.prompt : task.title`) and
 * the direct chat-session launch planned for v2. Keeping the text here is what
 * makes the backends interchangeable — if they diverged, an idea would behave
 * differently depending on whether the task-board plugin happens to be
 * installed.
 *
 * Framework-free (no cordis, no HTTP) so the bridge, the launch service and the
 * unit tests can all read it without pulling the mirror in.
 */
import type { IdeaRecord } from './core/ideas.ts';
/**
 * The executable prompt = the tag prompt lines, one per line; when no tag
 * carries a prompt line, a mission prompt derived from the card itself.
 * The fallback is mandatory: Task Board launches a run with
 * `task.prompt !== '' ? task.prompt : task.title` (the description is never
 * injected into the session), so an empty prompt would ship the card's bare
 * TITLE to the launched agent — unexploitable for the common idea whose tags
 * are all plain names. The body is the captured spec, so it becomes the run
 * instruction instead.
 */
export declare function runPromptOf(idea: IdeaRecord): string;
