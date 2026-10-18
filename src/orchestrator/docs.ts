import { errorMessage } from '../util/errors.ts';
import { matchesAnyGlob } from '../workflow/glob.ts';

/** Matching files named in the reason; more are counted. */
const FILES_SHOWN = 5;

/** What decides whether the documentation stage is needed. */
export interface DocsFacts {
  /** The latest analysis of the issue says documentation must change (`docs_needed`). */
  docsNeeded: boolean;
  /** `pipeline.docs_paths`: documentation files; a change in them means the docs were already written. */
  docsPaths: readonly string[];
  /** `pipeline.docs_trigger_paths`; `[]` turns the path trigger off. */
  triggerPaths: readonly string[];
  /** The repository-relative files the branch changes against the base branch; throws when that cannot be told. */
  changedFiles: () => Promise<string[]>;
}

/** Whether the documentation stage is needed, and why (or why not), for the transition reason. */
export interface DocsDecision {
  needed: boolean;
  reason: string;
}

/**
 * Whether an implemented issue needs the documentation stage: the analysis says `docs_needed`, or a changed file matches
 * `docs_trigger_paths` while no changed file matches `docs_paths` (the developer already documented it). Git is asked
 * only when the analysis does not decide. Fail safe: when the changed files cannot be determined, the stage is needed
 * and the reason says why.
 */
export async function docsNeeded(facts: DocsFacts): Promise<DocsDecision> {
  if (facts.docsNeeded) return { needed: true, reason: 'the analysis says documentation must change' };
  if (facts.triggerPaths.length === 0) return { needed: false, reason: 'no trigger (the analysis needs no docs, pipeline.docs_trigger_paths is empty)' };
  let files: string[];
  try {
    files = await facts.changedFiles();
  } catch (error) {
    return { needed: true, reason: `the changed files could not be determined (${errorMessage(error).replace(/\s+/g, ' ').trim()}), documenting to be safe` };
  }
  const matching = files.filter((file) => matchesAnyGlob(file, facts.triggerPaths));
  if (matching.length === 0) return { needed: false, reason: `no trigger (none of ${files.length} changed file(s) matches pipeline.docs_trigger_paths)` };
  const documented = files.filter((file) => matchesAnyGlob(file, facts.docsPaths));
  if (documented.length > 0) return { needed: false, reason: `documentation already changed (${documented.slice(0, FILES_SHOWN).join(', ')}${documented.length > FILES_SHOWN ? ', …' : ''})` };
  const shown = matching.slice(0, FILES_SHOWN).join(', ');
  return { needed: true, reason: `${matching.length} changed file(s) match pipeline.docs_trigger_paths without a change in pipeline.docs_paths: ${shown}${matching.length > FILES_SHOWN ? ', …' : ''}` };
}
