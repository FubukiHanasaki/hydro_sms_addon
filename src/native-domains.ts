import { Context, ForbiddenError, type Handler } from 'hydrooj';

// Block the original handlers before prepare/operation, including every POST
// operation on those routes. Keep DomainModel available to the plugin and host.
export function disableNativeDomainManagement(ctx: Context) {
  const blocked = ['DomainDashboard', 'DomainEdit', 'DomainUser', 'DomainPermission', 'DomainRole', 'DomainJoinApplications', 'DomainUserGroup', 'DomainJoin', 'HomeDomainCreate'];
  const allowedHomeRequest = (handler: Handler) => handler.context.method === 'GET' ||
    (handler.context.method === 'POST' && !!handler.context.request.body && typeof handler.context.request.body === 'object' &&
      !Array.isArray(handler.context.request.body) && (handler.context.request.body as Record<string, unknown>).operation === 'star');
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
    // Render only the native personal-domain table when requested by the tab.
    if (handler.context.method === 'POST' || handler.context.query.sms_domains === '1') return;
    handler.response.redirect = `${handler.url('sms_panel')}#domains`;
    return 'cleanup';
  });
  ctx.on('handler/after/HomeDomain#get', async handler => {
    handler.response.template = 'sms_my_domains.html';
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
