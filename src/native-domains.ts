import { Context, ForbiddenError, PRIV, type Handler } from 'hydrooj';
import type { OrganizationService } from './organization';

// Block the original handlers before prepare/operation, including every POST
// operation on those routes. Keep DomainModel available to the plugin and host.
export function disableNativeDomainManagement(ctx: Context, organization: OrganizationService) {
  const managed = ['DomainDashboard', 'DomainEdit', 'DomainUser'];
  const blocked = ['DomainPermission', 'DomainRole', 'DomainJoinApplications', 'DomainUserGroup', 'DomainJoin', 'HomeDomainCreate'];
  const allowedHomeRequest = (handler: Handler) => handler.context.method === 'GET' ||
    (handler.context.method === 'POST' && !!handler.context.request.body && typeof handler.context.request.body === 'object' &&
      !Array.isArray(handler.context.request.body) && (handler.context.request.body as Record<string, unknown>).operation === 'star');
  ctx.on('handler/create/http', async handler => {
    const name = handler.constructor.name.replace(/Handler$/, '');
    if (blocked.includes(name) || (managed.includes(name) && handler.context.method !== 'GET') || (name === 'HomeDomain' && !allowedHomeRequest(handler))) throw new ForbiddenError();
  });
  for (const name of blocked) {
    ctx.on(`handler/before-prepare/${name}`, async () => { throw new ForbiddenError(); });
  }
  for (const name of managed) ctx.on(`handler/before-prepare/${name}`, async handler => {
    if (handler.context.method !== 'GET' || !handler.user?.hasPriv(PRIV.PRIV_USER_PROFILE) || !await organization.canManage(handler.user._id, handler.domain._id)) throw new ForbiddenError();
    handler.response.addHeader('Cache-Control', 'private, no-store');
    handler.response.addHeader('Vary', 'Cookie, Authorization');
    handler.response.redirect = handler.url('sms_domain_manage') + (name === 'DomainUser' ? '#members' : '#profile');
    return 'cleanup';
  });
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
    handler.response.body.smsManagedDomainIds = (await organization.managementDomains(handler.user._id)).map(domain => domain._id);
  });
  // The Nav checker is synchronous. Resolve plugin authority on this request,
  // without deriving management access from a native role or ownership.
  ctx.on('handler/after', async (handler: Handler & { smsCanManageDomain?: boolean }) => {
    if (handler.response.template && handler.user?.hasPriv(PRIV.PRIV_USER_PROFILE)) {
      handler.smsCanManageDomain = await organization.canManage(handler.user._id, handler.domain._id);
      handler.response.addHeader('Cache-Control', 'private, no-store');
      handler.response.addHeader('Vary', 'Cookie, Authorization');
    }
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
