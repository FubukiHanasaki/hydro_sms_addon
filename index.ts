import { TeacherService } from './src/teachers';
import { TeachingService } from './src/teaching';
import { RatingService } from './src/rating';
import { hydroContestGateway, installRating } from './src/rating-hydro';
import { AccountManagement } from './src/account-management';
import { disableNativeDomainManagement } from './src/native-domains';
import { OrganizationService } from './src/organization';
import { Context, Handler, PRIV, ForbiddenError, UserModel, DomainModel, TokenModel, Types, PERM } from 'hydrooj';
import { HydroAccounts } from './src/accounts';
import { StudentService } from './src/service';
import { SmsError } from './src/types';

export const name = 'hydro-sms-addon';

export async function apply(ctx: Context) {
  const service = new StudentService(ctx.db.db, new HydroAccounts(ctx.db.db, (mail, username, password) => UserModel.create(mail, username, password, undefined, '127.0.0.1', PRIV.PRIV_DEFAULT)));
  await service.init();
  const organization = new OrganizationService(ctx.db.db, service, {
    create: (id, owner, name, bulletin) => DomainModel.add(id, owner, name, bulletin),
    edit: (id, data) => DomainModel.edit(id, data),
    join: (id, uid, joined) => DomainModel.setJoin(id, uid, joined),
  });
  await organization.init();
  const teachers = new TeacherService(ctx.db.db, service, organization);
  await teachers.init();
  const accounts = new AccountManagement(ctx.db.db, service, {
    create: (mail, username, password) => UserModel.create(mail, username, password, undefined, '127.0.0.1', PRIV.PRIV_DEFAULT),
    rename: (uid, username) => UserModel.setUname(uid, username), password: (uid, password) => UserModel.setPassword(uid, password),
    privileges: (uid, priv) => UserModel.setPriv(uid, priv), revoke: (uid) => TokenModel.delByUid(uid),
    normalizeUsername: (value) => { if (!Types.Username[1](value)) throw new SmsError(400, '用户名无效'); return Types.Username[0](value); },
    profilePrivilege: PRIV.PRIV_USER_PROFILE, defaultPrivileges: PRIV.PRIV_DEFAULT,
  });
  await accounts.init();
  ctx.on('handler/before-prepare', async handler => { if (handler.user?._id > 0) await organization.ensureMainMembers(handler.user._id); });
  disableNativeDomainManagement(ctx);
  const rating = new RatingService(ctx.db.db, service, hydroContestGateway(ctx), () => UserModel._deleteUserCache(true, true));
  await rating.init();
  installRating(ctx, rating, organization);
  const teaching = new TeachingService(ctx.db.db, service, organization, rating);
  await teaching.init();
  UserModel._deleteUserCache(true, true);

  function privateResponse(handler: Handler) {
    handler.response.addHeader('Cache-Control', 'private, no-store');
    handler.response.addHeader('Vary', 'Cookie, Authorization');
  }
  class SmsPanelHandler extends Handler {
    async get() {
      this.checkPriv(PRIV.PRIV_USER_PROFILE);
      privateResponse(this);
      this.response.template = 'sms_panel.html';
      this.response.body = { smsApi: this.url('sms_api_students'), smsMe: this.url('sms_api_me'), smsPermissions: this.url('sms_api_permissions'), smsAudit: this.url('sms_api_audit'), smsUsers: this.url('sms_api_users'), smsFilters: this.url('sms_api_student_filters'), smsDomains: this.url('sms_api_domains'), smsClasses: this.url('sms_api_classes'), smsAccounts: this.url('sms_api_accounts'), smsRating: this.url('sms_api_rating_board'), smsRatingHistory: this.url('sms_api_rating_history', { uid: 0 }).replace(/\/0$/, ''), smsRatingImport: this.url('sms_api_rating_import'), smsRatingContests: this.url('sms_api_rating_contests') };
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
    async get() { await this.run(() => service.list(this.user._id, this.context.query.q, this.context.query.page, this.context.query.status, { grade: this.context.query.grade, school: this.context.query.school, domainId: this.context.query.domainId })); }
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
  class SmsStudentFiltersHandler extends SmsApiHandler {
    async get() { await this.run(() => service.filterOptions(this.user._id)); }
  }

  class SmsRatingBoardHandler extends SmsApiHandler {
    async get() { this.checkPerm(PERM.PERM_VIEW_RANKING); await this.run(async () => { const scope = await organization.ratingScope(this.user._id, this.args.domainId, this.context.query.classId); return { ...await rating.board(scope.domainId, this.context.query.q, this.context.query.page ?? 1, this.context.query.mode ?? 'all', this.context.query.grade, this.context.query.school), classScope: scope }; }); }
  }
  class SmsRatingHistoryHandler extends SmsApiHandler {
    async get() { this.checkPerm(PERM.PERM_VIEW_RANKING); await this.run(() => rating.history(this.context.params.uid, this.context.query.page ?? 1)); }
  }
  class SmsRatingImportHandler extends SmsApiHandler {
    async post() { await this.run(() => rating.importRecords(this.user._id, this.body())); }
  }
  class SmsRatingContestsHandler extends SmsApiHandler {
    async get() { await this.run(() => rating.configList(this.user._id)); }
    async post() { await this.run(() => rating.configure(this.user._id, this.body())); }
  }
  class SmsRatingRecalculateHandler extends SmsApiHandler {
    async post() { await this.run(async () => { await service.requireAdmin(this.user._id); await rating.sync(this.user._id); return { revision: (await rating.head()).revision }; }); }
  }
  ctx.Route('sms_api_rating_board', '/sms/api/rating/board', SmsRatingBoardHandler);
  ctx.Route('sms_api_rating_history', '/sms/api/rating/users/:uid', SmsRatingHistoryHandler);
  ctx.Route('sms_api_rating_import', '/sms/api/rating/import', SmsRatingImportHandler);
  ctx.Route('sms_api_rating_contests', '/sms/api/rating/contests', SmsRatingContestsHandler);
  ctx.Route('sms_api_rating_recalculate', '/sms/api/rating/recalculate', SmsRatingRecalculateHandler);
  class SmsAccountsHandler extends SmsApiHandler {
    async get() { await this.run(() => accounts.list(this.user._id, this.context.query.q, this.context.query.enabled, this.context.query.page)); }
    async post() { await this.run(() => accounts.create(this.user._id, this.body())); }
  }
  class SmsAccountHandler extends SmsApiHandler {
    async post() { await this.run(() => accounts.update(this.user._id, this.context.params.uid, this.body())); }
  }
  ctx.Route('sms_api_accounts', '/sms/api/accounts', SmsAccountsHandler);
  ctx.Route('sms_api_account', '/sms/api/accounts/:uid', SmsAccountHandler);
  class SmsDomainsHandler extends SmsApiHandler {
    async get() { await this.run(() => organization.domainList(this.user._id)); }
    async post() { await this.run(() => organization.domainSave(this.user._id, this.body())); }
  }
  class SmsDomainMembersHandler extends SmsApiHandler {
    async get() { await this.run(() => organization.domainMembers(this.user._id, this.context.params.id, this.context.query.q, this.context.query.page)); }
    async post() { await this.run(() => organization.domainMembership(this.user._id, this.context.params.id, this.body())); }
  }
  class SmsClassesHandler extends SmsApiHandler {
    async get() { await this.run(() => organization.classList(this.user._id, this.context.query.q, this.context.query.domainId, this.context.query.status, this.context.query.page)); }
    async post() { await this.run(() => organization.classSave(this.user._id, null, this.body())); }
  }
  class SmsClassHandler extends SmsApiHandler {
    async get() { await this.run(() => organization.classDetail(this.user._id, this.context.params.id)); }
    async post() { await this.run(() => organization.classSave(this.user._id, this.context.params.id, this.body())); }
  }
  class SmsTeachersHandler extends SmsApiHandler {
    async get() { await this.run(() => teachers.list(this.user._id, this.context.query.q, this.context.query.status, this.context.query.page)); }
    async post() { await this.run(() => teachers.save(this.user._id, this.body())); }
  }
  class SmsTeacherHandler extends SmsApiHandler {
    async get() { await this.run(() => teachers.detail(this.user._id, this.context.params.id)); }
    async post() { await this.run(() => teachers.save(this.user._id, this.body(), this.context.params.id)); }
  }
  ctx.Route('sms_api_teachers', '/sms/api/teachers', SmsTeachersHandler);
  ctx.Route('sms_api_teacher', '/sms/api/teachers/:id', SmsTeacherHandler);
  class SmsScheduleBoardHandler extends SmsApiHandler {
    async get() { await this.run(() => teaching.scheduleBoard(this.user._id, this.context.query.teacherUid, this.context.query.from, this.context.query.to)); }
  }
  ctx.Route('sms_api_schedule_board', '/sms/api/teaching/schedules', SmsScheduleBoardHandler);
  class SmsTeachingClassesHandler extends SmsApiHandler {
    async get() { await this.run(() => teaching.classes(this.user._id)); }
  }
  ctx.Route('sms_api_teaching_classes', '/sms/api/teaching/classes', SmsTeachingClassesHandler);
  class SmsTeachingHandler extends SmsApiHandler {
    async get() { await this.run(() => teaching.overview(this.user._id, this.context.params.id, this.context.query.from, this.context.query.to)); }
  }
  class SmsCourseSaveHandler extends SmsApiHandler {
    async post() { await this.run(() => teaching.saveCourse(this.user._id, this.context.params.id, this.body())); }
  }
  class SmsScheduleSaveHandler extends SmsApiHandler {
    async post() { await this.run(() => teaching.savePlan(this.user._id, this.context.params.id, this.body())); }
  }
  class SmsLessonSaveHandler extends SmsApiHandler {
    async post() { await this.run(() => teaching.changeLesson(this.user._id, this.context.params.id, this.context.params.lessonId, this.body())); }
  }
  ctx.Route('sms_api_teaching', '/sms/api/classes/:id/teaching', SmsTeachingHandler);
  ctx.Route('sms_api_courses_save', '/sms/api/classes/:id/courses', SmsCourseSaveHandler);
  ctx.Route('sms_api_schedules_save', '/sms/api/classes/:id/schedules', SmsScheduleSaveHandler);
  ctx.Route('sms_api_lessons_save', '/sms/api/classes/:id/lessons/:lessonId', SmsLessonSaveHandler);
  ctx.Route('sms_api_domains', '/sms/api/domains', SmsDomainsHandler);
  ctx.Route('sms_api_domain_members', '/sms/api/domains/:id/members', SmsDomainMembersHandler);
  ctx.Route('sms_api_classes', '/sms/api/classes', SmsClassesHandler);
  ctx.Route('sms_api_class', '/sms/api/classes/:id', SmsClassHandler);
  ctx.Route('sms_panel', '/sms', SmsPanelHandler);
  ctx.Route('sms_api_me', '/sms/api/me', SmsMeHandler);
  ctx.Route('sms_api_students', '/sms/api/students', SmsStudentsHandler);
  ctx.Route('sms_api_student', '/sms/api/students/:id', SmsStudentHandler);
  ctx.Route('sms_api_permissions', '/sms/api/permissions', SmsPermissionsHandler);
  ctx.Route('sms_api_audit', '/sms/api/audit', SmsAuditHandler);
  ctx.Route('sms_api_users', '/sms/api/users', SmsUsersHandler);
  ctx.Route('sms_api_student_filters', '/sms/api/student-filters', SmsStudentFiltersHandler);
  ctx.injectUI('Nav', 'sms_panel', { prefix: 'sms' }, PRIV.PRIV_USER_PROFILE);
  ctx.i18n.load('zh', { sms_panel: '学生管理', 'Solved {0} problems': '已通过 {0} 题' });
  ctx.i18n.load('en', { sms_panel: 'Student management' });
  ctx.on('handler/after/UserDetail', async (handler) => {
    privateResponse(handler);
    if (!handler.user?._id || !handler.user.hasPriv(PRIV.PRIV_USER_PROFILE)) return;
    const student = await service.byHydroUid(handler.user._id, handler.response.body.udoc._id);
    if (student) handler.response.body.smsStudent = student;
  });
}
