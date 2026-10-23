import { Context, ForbiddenError, type Handler } from 'hydrooj';

// Block the original handlers before prepare/operation, including every POST
// operation on those routes. Personal domain favorites remain native.
// Keep DomainModel available to the plugin and host.
export function disableNativeDomainManagement(ctx: Context) {
  const blocked = ['DomainDashboard', 'DomainEdit', 'DomainUser', 'DomainPermission', 'DomainRole', 'DomainJoinApplications', 'DomainUserGroup', 'DomainJoin', 'HomeDomainCreate'];
  const allowedHomeRequest = (handler: Handler) => {
    if (handler.context.method === 'GET') return true;
    const body = handler.context.request.body;
    return handler.context.method === 'POST' && !!body && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>).operation === 'star';
  };
  ctx.on('handler/create/http', async handler => {
    const name = handler.constructor.name.replace(/Handler$/, '');
    if (blocked.includes(name) || (name === 'HomeDomain' && !allowedHomeRequest(handler))) throw new ForbiddenError();
  });
  for (const name of blocked) {
    ctx.on(`handler/before-prepare/${name}`, async () => { throw new ForbiddenError(); });
  }
  ctx.on('handler/before-prepare/HomeDomain', async handler => {
    if (!allowedHomeRequest(handler)) throw new ForbiddenError();
    handler.response.addHeader('Cache-Control', 'private, no-store');
  });
  ctx.on('handler/after/HomeDomain#get', async handler => {
    handler.response.template = 'sms_home_domains.html';
  });
  // Hydro also exposes group writes through its generic API executor.
  ctx.on('api/before/domain.group', async () => { throw new ForbiddenError(); });
  const ui = (globalThis as unknown as { Hydro: { ui: { nodes: Record<string, { name: string; checker: (...args: unknown[]) => boolean }[]> } } }).Hydro.ui;
  ctx.effect(() => {
    const nodes = ['Nav', 'DomainManage'].flatMap(key => ui.nodes[key].filter(node => node.name.startsWith('domain_')));
    const original = nodes.map(node => ({ node, checker: node.checker }));
    for (const { node } of original) node.checker = () => false;
    return () => { for (const { node, checker } of original) node.checker = checker; };
  });
}
