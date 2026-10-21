import { Context, Handler, PRIV, ForbiddenError, UserModel } from 'hydrooj';
import { HydroAccounts } from './src/accounts';
import { StudentService } from './src/service';
import { SmsError } from './src/types';

export const name = 'hydro-sms-addon';

export async function apply(ctx: Context) {
  const service = new StudentService(ctx.db.db, new HydroAccounts(ctx.db.db, (mail, username, password) => UserModel.create(mail, username, password, undefined, '127.0.0.1', PRIV.PRIV_DEFAULT)));
  await service.init();

  function privateResponse(handler: Handler) {
    handler.response.addHeader('Cache-Control', 'private, no-store');
    handler.response.addHeader('Vary', 'Cookie, Authorization');
  }
  class SmsPanelHandler extends Handler {
    async get() {
      this.checkPriv(PRIV.PRIV_USER_PROFILE);
      privateResponse(this);
      this.response.template = 'sms_panel.html';
      this.response.body = { smsApi: this.url('sms_api_students'), smsMe: this.url('sms_api_me'), smsPermissions: this.url('sms_api_permissions'), smsAudit: this.url('sms_api_audit'), smsUsers: this.url('sms_api_users') };
    }
  }
  class SmsApiHandler extends Handler {
    async prepare() {
      privateResponse(this);
      // Keep APIs as actual 403 JSON responses rather than Hydro's UI login redirect.
      if (!this.user?._id || !this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new ForbiddenError();
      if (this.context.method !== 'GET') {
        const origin = this.context.get('origin');
        // Koa 3's request.origin is the untrusted Origin header itself. Build
        // the destination origin from the configured proxy-aware protocol/host.
        const destination = `${this.context.request.protocol}://${this.context.request.host}`;
        if (this.context.get('x-sms-request') !== '1' || !origin || origin !== destination) throw new ForbiddenError();
        if (!this.context.is('application/json')) throw new ForbiddenError();
      }
    }
    async run(work: () => Promise<unknown>) {
      try {
        this.response.body = { data: await work() };
      } catch (error) {
        if (!(error instanceof SmsError)) throw error;
        this.response.status = error.status;
        this.response.body = { message: error.message };
      }
      this.response.type = 'application/json';
    }
    body() { return this.context.request.body; }
  }
  class SmsMeHandler extends SmsApiHandler {
    async get() { await this.run(() => service.me(this.user._id)); }
  }
  class SmsStudentsHandler extends SmsApiHandler {
    async get() { await this.run(() => service.list(this.user._id, this.context.query.q, this.context.query.page, this.context.query.status)); }
    async post() { await this.run(() => service.create(this.user._id, this.body())); }
  }
  class SmsStudentHandler extends SmsApiHandler {
    async get() { await this.run(() => service.detail(this.user._id, this.context.params.id)); }
    async post() { await this.run(() => service.update(this.user._id, this.context.params.id, this.body())); }
  }
  class SmsPermissionsHandler extends SmsApiHandler {
    async get() { await this.run(() => service.permissions(this.user._id)); }
    async post() { await this.run(() => service.setGrant(this.user._id, this.body())); }
  }
  class SmsAuditHandler extends SmsApiHandler {
    async get() { await this.run(() => service.auditList(this.user._id)); }
  }
  class SmsUsersHandler extends SmsApiHandler {
    async get() { await this.run(() => service.searchUsers(this.user._id, this.context.query.q, this.context.query.studentId)); }
  }

  ctx.Route('sms_panel', '/sms', SmsPanelHandler);
  ctx.Route('sms_api_me', '/sms/api/me', SmsMeHandler);
  ctx.Route('sms_api_students', '/sms/api/students', SmsStudentsHandler);
  ctx.Route('sms_api_student', '/sms/api/students/:id', SmsStudentHandler);
  ctx.Route('sms_api_permissions', '/sms/api/permissions', SmsPermissionsHandler);
  ctx.Route('sms_api_audit', '/sms/api/audit', SmsAuditHandler);
  ctx.Route('sms_api_users', '/sms/api/users', SmsUsersHandler);
  ctx.injectUI('Nav', 'sms_panel', { prefix: 'sms' }, PRIV.PRIV_USER_PROFILE);
  ctx.i18n.load('zh', { sms_panel: '学生管理' });
  ctx.i18n.load('en', { sms_panel: 'Student management' });
  ctx.on('handler/after/UserDetail', async (handler) => {
    privateResponse(handler);
    if (!handler.user?._id || !handler.user.hasPriv(PRIV.PRIV_USER_PROFILE)) return;
    const student = await service.byHydroUid(handler.user._id, handler.response.body.udoc._id);
    if (student) handler.response.body.smsStudent = student;
  });
}
