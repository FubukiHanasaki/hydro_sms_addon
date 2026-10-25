// Narrow compile-time boundary for the Hydro 5.0 plugin API used here.
// Hydro ships implementation .ts files; importing its complete type graph would
// type-check the host and every upstream package under this plugin's settings.
// Runtime compatibility is covered by an isolated Hydro integration run.
import type { Db } from 'mongodb';
export interface Context {
  db: { db: Db };
  Route(name: string, path: string, handler: typeof Handler): void;
  injectUI(node: string, name: string, args: Record<string, unknown>, privilege: number): void;
  i18n: { load(language: string, entries: Record<string, string>): void };
  on(event: string, callback: (handler: Handler) => Promise<void | string>): void;
  effect(callback: () => (() => void)): void;
}
export class Handler {
  args: Record<string, any>;
  domain: { _id: string };
  user: { _id: number; hasPriv(privilege: number): boolean };
  context: {
    method: string;
    params: Record<string, string>;
    query: Record<string, string | string[] | undefined>;
    request: { body: unknown; protocol: string; host: string };
    get(name: string): string;
    is(type: string): string | false | null;
  };
  response: {
    body: any;
    status: number;
    type: string;
    template?: string;
    redirect?: string;
    addHeader(name: string, value: string): void;
  };
  checkPerm(permission: bigint): void;
  checkPriv(privilege: number): void;
  url(name: string, args?: Record<string, unknown>): string;
}
export const PRIV: { PRIV_USER_PROFILE: number; PRIV_DEFAULT: number };
export const UserModel: {
  getById(domain: string, uid: number): Promise<any>;
  listGroup(domain: string, uid: number): Promise<any[]>;
  create(mail: string, username: string, password: string, uid?: number, ip?: string, priv?: number): Promise<number>;
  setUname(uid: number, username: string): Promise<unknown>;
  setPassword(uid: number, password: string): Promise<unknown>;
  _deleteUserCache(value: true, receiver?: boolean): void;
  setPriv(uid: number, priv: number): Promise<unknown>;
};
export const TokenModel: { delByUid(uid: number): Promise<unknown> };
export const Types: { Username: [(value: string) => string, (value: string) => boolean] };
export class ForbiddenError extends Error {}

export const DomainModel: {
  add(id: string, owner: number, name: string, bulletin: string): Promise<unknown>;
  edit(id: string, data: { name: string; bulletin: string }): Promise<unknown>;
  setJoin(id: string, uid: number, join: boolean): Promise<unknown>;
};

export const ContestModel: { get(domainId: string, id: import('mongodb').ObjectId): Promise<any>; getMultiStatus(domainId: string, query: any): any; RULES: Record<string, any>; };
export const PERM: { PERM_VIEW_RANKING: bigint; PERM_VIEW_CONTEST: bigint; PERM_VIEW_HIDDEN_CONTEST: bigint };
export const RecordModel: any;
