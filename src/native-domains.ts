import { Context, ForbiddenError } from 'hydrooj';

// Block the original handlers before prepare/operation, including every POST
// operation on those routes. Keep DomainModel available to the plugin and host.
export function disableNativeDomainManagement(ctx: Context) {
  const blocked = ['DomainDashboard', 'DomainEdit', 'DomainUser', 'DomainPermission', 'DomainRole', 'DomainJoinApplications', 'DomainUserGroup', 'DomainJoin', 'HomeDomainCreate'];
  ctx.on('handler/create/http', async handler => {
    const name = handler.constructor.name.replace(/Handler$/, '');
    if (blocked.includes(name) || (name === 'HomeDomain' && handler.context.method !== 'GET')) throw new ForbiddenError();
  });
  for (const name of blocked) {
    ctx.on(`handler/before-prepare/${name}`, async () => { throw new ForbiddenError(); });
  }
  ctx.on('handler/before-prepare/HomeDomain', async handler => {
    if (handler.context.method !== 'GET') throw new ForbiddenError();
    handler.response.addHeader('Cache-Control', 'private, no-store');
    handler.response.redirect = `${handler.url('sms_panel')}#domains`;
    return 'cleanup';
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
