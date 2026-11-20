import type { ProjectView } from './types';

/** The most representative concrete route for a project (used by the traffic shooter and snippets). */
export function primaryRoute(project: ProjectView): string {
  const rules = project.rateLimitRules;
  const exact = rules.filter((r) => r.routePattern !== '*' && !r.routePattern.endsWith('*') && r.routePattern !== '/ws/frame');
  if (exact.length > 0) return (exact.find((r) => r.routePattern === '/api/room/join') ?? exact[0]!).routePattern;
  const prefix = rules.find((r) => r.routePattern !== '*' && r.routePattern.endsWith('*'));
  if (prefix) return `${prefix.routePattern.slice(0, -1)}demo`;
  return '/api/demo';
}
