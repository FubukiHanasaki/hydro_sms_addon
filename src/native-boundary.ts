/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
import { APIS, Context, ContestModel, DomainModel, ForbiddenError, PERM, PRIV, RecordModel, TokenModel, UserModel } from 'hydrooj';
import { StudentService } from './service';
import { ObjectId } from 'mongodb';

// A business target in a payload must never select the permissions used to
// authorize the URL's native handler. This layer also runs on connections.
export function installNativeBoundary(ctx: Context, students: StudentService) {
  ctx.server.addLayer('sms-native-domain', async (context: any, next: () => Promise<void>) => {
    const hc = context.HydroContext, id = hc?.domain?._id;
    if (id && hc.user) {
      if (hc.args.domainId !== id) hc.user = await (await UserModel.getById(id, hc.user._id)).private();
      hc.args.domainId = id;
      try { hc.user.scope = BigInt(context.session.scope ?? hc.user.scope); } catch { hc.user.scope = 0n; }
    }
    await next();
  });
  ctx.on('handler/create/ws', async (h: any) => {
    if (!h.noCheckPermView && !h.user.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN)) h.checkPerm(PERM.PERM_VIEW);
    if (!['RecordMainConnectionHandler', 'RecordDetailConnectionHandler'].includes(h.constructor.name)) return;
    const list = h.constructor.name === 'RecordMainConnectionHandler';
    const send = h.send.bind(h);
    let pending = Promise.resolve(), closed = false;
    // Queries use a list projection, but bus updates contain complete records.
    h.send = (payload: any) => {
      if (payload?.error) return send(payload);
      pending = pending.then(async () => {
        if (closed) return;
        const actor = h.user._id, token = actor ? await TokenModel.get(h.session?._id, TokenModel.TYPE_SESSION) : null;
        if (actor && (!token || token.uid !== actor || +new Date(token.expireAt) <= Date.now())) throw new ForbiddenError();
        const current = await UserModel.getById(h.domain._id, actor), scope = BigInt(token?.scope ?? h.session.scope ?? h.user.scope);
        if ((BigInt(current.perm) & scope & PERM.PERM_VIEW) !== PERM.PERM_VIEW) throw new ForbiddenError();
        h.session.scope = scope.toString();
        const rdoc = payload?.rdoc ?? (h.rid ? await RecordModel.get(h.domain._id, new ObjectId(h.rid)) : null);
        const contest = rdoc ? await h.smsAuthorizeRecord?.(rdoc, current) : null;
        if (rdoc?.contest) {
          const exam = await ctx.db.db.collection('sms_exams').findOne({ _id: `${rdoc.domainId}:${rdoc.contest}` as any }, { projection: { classIds: 1 } });
          if (exam) {
            const scope = await students.authorization.scope(actor, 'exams.read');
            if (scope !== null && !exam.classIds.some((id: string) => scope.includes(id))) throw new ForbiddenError();
          }
        }
        if (!list && payload?.rdoc && rdoc.uid !== actor) {
          const perm = BigInt(current.perm) & scope;
          let code = current.hasPriv(PRIV.PRIV_READ_RECORD_CODE) || (perm & PERM.PERM_READ_RECORD_CODE) === PERM.PERM_READ_RECORD_CODE;
          if (!code && (perm & PERM.PERM_READ_RECORD_CODE_ACCEPT) === PERM.PERM_READ_RECORD_CODE_ACCEPT) code = (await ctx.db.db.collection('document.status').findOne({ domainId: h.domain._id, docType: 10, docId: rdoc.pid, uid: actor }, { projection: { status: 1 } }))?.status === 1;
          if (contest) {
            code ||= h.user.own(contest);
            if (!code && contest.allowViewCode && +new Date(contest.endAt) <= Date.now()) code = !!(await ContestModel.getStatus(h.domain._id, contest.docId, actor))?.attend;
          }
          if (!code) payload = { ...payload, rdoc: { ...payload.rdoc, code: '', files: {}, compilerTexts: [] } };
        }
        if (list && payload?.rdoc) {
          const fields: string[] = h.pretest && rdoc.uid === actor
            ? Object.keys(payload.rdoc).filter(key => !['code', 'input', 'files'].includes(key))
            : RecordModel.PROJECTION_LIST.filter((key: string) => key !== 'files');
          payload = { ...payload, rdoc: Object.fromEntries(fields.filter(key => Object.hasOwn(payload.rdoc, key)).map(key => [key, payload.rdoc[key]])) };
        }
        send(payload);
      }).catch(() => { closed = true; h.close(4003, 'Forbidden'); });
    };
  });
  // Guard the API definitions so nested and websocket/RPC execution follows
  // the same target-domain boundary as direct HTTP requests.
  const reads = ['problem', 'problems', 'groups', 'user', 'users', 'domain', 'domain.current'];
  for (const name of reads) ctx.on(`handler/api/before/${name}`, async (h: any) => {
    // These APIs also accept a top-level target instead of an args envelope.
    // Restore it only after URL authorization, immediately before guarded API
    // execution; ordinary native handlers always retain the URL's domain.
    const target = h.context.request.body?.domainId ?? h.context.query.domainId;
    if (target !== undefined) h.args.domainId = target;
  });
  ctx.effect(() => {
    const installed: { name: string; original: any; wrapped: any }[] = [];
    for (const name of reads) {
      const original = APIS[name];
      if (!original) continue;
      const wrapped = { ...original, func: async (h: any, input: any, ...rest: any[]) => {
        const value = name === 'domain' ? input.id || h.domain._id : input.domainId ?? h.domain._id;
        if (typeof value !== 'string') throw new ForbiddenError();
        const domain = await DomainModel.get(value);
        if (!domain) throw new ForbiddenError();
        const user = await (await UserModel.getById(domain._id, h.user._id)).private();
        try { user.scope = BigInt(h.session?.scope ?? h.user.scope); } catch { throw new ForbiddenError(); }
        if (!user.hasPerm(PERM.PERM_VIEW)) throw new ForbiddenError();
        if (['problem', 'problems'].includes(name) && !user.hasPerm(PERM.PERM_VIEW_PROBLEM)) throw new ForbiddenError();
        const local = Object.assign(Object.create(h), { domain, user, args: { ...h.args, domainId: domain._id } });
        const args = { ...input, domainId: domain._id, ...name === 'domain' ? { id: domain._id } : {} };
        let ownGroups = false;
        if (name === 'groups' && !await students.authorization.fullRead(user._id, domain._id)) {
          if (args.uid !== undefined && args.uid !== user._id) throw new ForbiddenError();
          if (!user._id) throw new ForbiddenError();
          args.uid = user._id; ownGroups = true;
        }
        const result = await original.func(local, args, ...rest);
        if (ownGroups) return result.map((group: any) => ({ ...group, uids: [user._id] }));
        // Serialize with target permissions, never the source URL's broader
        // private-profile permission when an API returns native user objects.
        if (name === 'user') return result?.serialize ? result.serialize(local) : result;
        if (name === 'users') return result.map((item: any) => item?.serialize ? item.serialize(local) : item);
        return result;
      } };
      APIS[name] = wrapped; installed.push({ name, original, wrapped });
    }
    return () => { for (const { name, original, wrapped } of installed) if (APIS[name] === wrapped) APIS[name] = original; };
  });
}
