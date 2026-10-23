import type { PathSetting, PipelineConfig } from './config.ts';

/**
 * Adds the app-root prefix of every app in a subdirectory to `globs` (`tests/**` → also `laravel/tests/**`).
 * Globs starting with `**` already match below any directory and stay as they are.
 */
export function expandForApps(globs: readonly string[], appDirs: readonly string[]): string[] {
  const result = [...globs];
  for (const dir of appDirs) {
    if (dir === '') continue;
    for (const glob of globs) {
      if (glob.startsWith('**')) continue;
      const prefixed = `${dir}/${glob}`;
      if (!result.includes(prefixed)) result.push(prefixed);
    }
  }
  return result;
}

export type EffectivePaths = Pick<PipelineConfig, 'testPaths' | 'docsPaths' | 'docsTriggerPaths' | 'securityPaths'>;

/**
 * The pipeline path globs for a workspace whose project-type apps (see `WorkspaceIntegration.appDirs`) sit in `appDirs`:
 * built-in defaults are extended for apps in subdirectories, globs set explicitly in WORKFLOW.md are used as they are.
 */
export function effectivePaths(pipeline: PipelineConfig, appDirs: readonly string[]): EffectivePaths {
  const pick = (setting: PathSetting, globs: string[]): string[] => (pipeline.explicitPaths.includes(setting) ? globs : expandForApps(globs, appDirs));
  return {
    testPaths: pick('test_paths', pipeline.testPaths),
    docsPaths: pick('docs_paths', pipeline.docsPaths),
    docsTriggerPaths: pick('docs_trigger_paths', pipeline.docsTriggerPaths),
    securityPaths: pick('security_paths', pipeline.securityPaths),
  };
}
